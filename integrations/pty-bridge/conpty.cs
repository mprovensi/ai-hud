// Micro-helper nativo Win32 ConPTY para o AI HUD (compilado via csc.exe nativo do Windows, zero deps).
// Protocolo NDJSON via stdin/stdout:
//   stdin  -> {"t":"in","d":"<base64>"} | {"t":"resize","cols":120,"rows":36} | {"t":"kill"}
//   stdout -> {"t":"out","d":"<base64>"} | {"t":"exit","code":0}
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class ConPtyBridge {
    const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    struct COORD {
        public short X;
        public short Y;
        public COORD(short x, short y) { X = x; Y = y; }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize;
        public int dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr Attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    static readonly object OutLock = new object();

    static void Emit(string json) {
        lock (OutLock) {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    static string FromB64(string b64) {
        if (string.IsNullOrEmpty(b64)) return "";
        return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
    }

    static int Main(string[] args) {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        short cols = 100;
        short rows = 30;
        string cwd = Environment.CurrentDirectory;
        string cmd = "powershell.exe -NoLogo";

        for (int i = 0; i < args.Length - 1; i++) {
            if (args[i] == "--cols") { short.TryParse(args[++i], out cols); }
            else if (args[i] == "--rows") { short.TryParse(args[++i], out rows); }
            else if (args[i] == "--cwd-b64") { cwd = FromB64(args[++i]); }
            else if (args[i] == "--cmd-b64") { cmd = FromB64(args[++i]); }
        }
        if (cols < 20) cols = 20;
        if (rows < 5) rows = 5;

        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = false };
        IntPtr ptyInRead, ptyInWrite, ptyOutRead, ptyOutWrite;
        if (!CreatePipe(out ptyInRead, out ptyInWrite, ref sa, 0) || !CreatePipe(out ptyOutRead, out ptyOutWrite, ref sa, 0)) {
            Emit("{\"t\":\"err\",\"m\":\"CreatePipe failed\"}");
            return 1;
        }

        IntPtr hPC;
        int hr = CreatePseudoConsole(new COORD(cols, rows), ptyInRead, ptyOutWrite, 0, out hPC);
        if (hr != 0) {
            Emit("{\"t\":\"err\",\"m\":\"CreatePseudoConsole failed: " + hr + "\"}");
            return 1;
        }

        // Fecha as pontas entregues ao ConPTY no processo pai
        CloseHandle(ptyInRead);
        CloseHandle(ptyOutWrite);

        IntPtr attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal(attrSize);
        if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) {
            Emit("{\"t\":\"err\",\"m\":\"InitializeProcThreadAttributeList failed\"}");
            ClosePseudoConsole(hPC);
            return 1;
        }

        if (!UpdateProcThreadAttribute(attrList, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) {
            Emit("{\"t\":\"err\",\"m\":\"UpdateProcThreadAttribute failed\"}");
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);
            ClosePseudoConsole(hPC);
            return 1;
        }

        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        // Evita herdar os pipes stdin/stdout/stderr do processo pai (Node.js) e força o filho a usar o ConPTY
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = IntPtr.Zero;
        si.StartupInfo.hStdOutput = IntPtr.Zero;
        si.StartupInfo.hStdError = IntPtr.Zero;
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        bool ok = CreateProcessW(
            null,
            new StringBuilder(cmd),
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            IntPtr.Zero,
            string.IsNullOrEmpty(cwd) ? null : cwd,
            ref si,
            out pi
        );

        DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);

        if (!ok) {
            int err = Marshal.GetLastWin32Error();
            Emit("{\"t\":\"err\",\"m\":\"CreateProcessW failed: " + err + "\"}");
            ClosePseudoConsole(hPC);
            return 1;
        }

        // Thread de leitura da saída do ConPTY -> stdout NDJSON base64
        Thread reader = new Thread(() => {
            byte[] buf = new byte[4096];
            uint n;
            while (ReadFile(ptyOutRead, buf, (uint)buf.Length, out n, IntPtr.Zero) && n > 0) {
                string b64 = Convert.ToBase64String(buf, 0, (int)n);
                Emit("{\"t\":\"out\",\"d\":\"" + b64 + "\"}");
            }
        });
        reader.IsBackground = true;
        reader.Start();

        // Thread de entrada stdin NDJSON -> ConPTY (write / resize / kill)
        Regex rxIn = new Regex("\"d\"\\s*:\\s*\"([^\"]*)\"");
        Regex rxCols = new Regex("\"cols\"\\s*:\\s*(\\d+)");
        Regex rxRows = new Regex("\"rows\"\\s*:\\s*(\\d+)");
        Thread writer = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line.Contains("\"t\":\"in\"")) {
                        Match m = rxIn.Match(line);
                        if (m.Success) {
                            byte[] data = Convert.FromBase64String(m.Groups[1].Value);
                            uint written;
                            if (data.Length > 0) WriteFile(ptyInWrite, data, (uint)data.Length, out written, IntPtr.Zero);
                        }
                    } else if (line.Contains("\"t\":\"resize\"")) {
                        Match mc = rxCols.Match(line);
                        Match mr = rxRows.Match(line);
                        short c = cols, r = rows;
                        if (mc.Success) short.TryParse(mc.Groups[1].Value, out c);
                        if (mr.Success) short.TryParse(mr.Groups[1].Value, out r);
                        if (c >= 20 && r >= 5) ResizePseudoConsole(hPC, new COORD(c, r));
                    } else if (line.Contains("\"t\":\"kill\"")) {
                        TerminateProcess(pi.hProcess, 1);
                        break;
                    }
                }
            } catch {}
            // Se stdin fechou (servidor desconectou), encerra o processo filho
            TerminateProcess(pi.hProcess, 0);
        });
        writer.IsBackground = true;
        writer.Start();

        WaitForSingleObject(pi.hProcess, INFINITE);
        uint exitCode = 0;
        GetExitCodeProcess(pi.hProcess, out exitCode);

        ClosePseudoConsole(hPC);
        CloseHandle(ptyInWrite);
        reader.Join(500);
        CloseHandle(ptyOutRead);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        Emit("{\"t\":\"exit\",\"code\":" + exitCode + "}");
        return 0;
    }
}

#!/usr/bin/env python3
"""
Micro-helper PTY para Linux/macOS (zero dependências externas).
Mesmo protocolo NDJSON via stdin/stdout do conpty.cs no Windows.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import threading


def from_b64(val: str) -> str:
    return base64.b64decode(val).decode("utf-8", errors="replace") if val else ""


def set_winsize(fd: int, cols: int, rows: int):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(5, rows), max(20, cols), 0, 0))
    except OSError:
        pass


def emit(obj: dict):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    cols, rows = 100, 30
    cwd = os.getcwd()
    cmd = os.environ.get("SHELL", "/bin/bash")
    args = sys.argv[1:]
    i = 0
    while i < len(args) - 1:
        k, v = args[i], args[i + 1]
        if k == "--cols":
            cols = int(v)
        elif k == "--rows":
            rows = int(v)
        elif k == "--cwd-b64":
            cwd = from_b64(v)
        elif k == "--cmd-b64":
            cmd = from_b64(v)
        i += 2

    pid, master_fd = pty.fork()
    if pid == 0:
        if cwd and os.path.isdir(cwd):
            os.chdir(cwd)
        os.environ["TERM"] = "xterm-256color"
        os.execvp("/bin/sh", ["/bin/sh", "-c", cmd])

    set_winsize(master_fd, cols, rows)

    def stdin_loop():
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                t = msg.get("t")
                if t == "in":
                    os.write(master_fd, base64.b64decode(msg.get("d", "")))
                elif t == "resize":
                    set_winsize(master_fd, int(msg.get("cols", cols)), int(msg.get("rows", rows)))
                elif t == "kill":
                    os.kill(pid, signal.SIGTERM)
                    break
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    threading.Thread(target=stdin_loop, daemon=True).start()

    try:
        while True:
            r, _, _ = select.select([master_fd], [], [], 0.25)
            if master_fd in r:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                emit({"t": "out", "d": base64.b64encode(data).decode("ascii")})
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
                emit({"t": "exit", "code": code})
                return
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
    emit({"t": "exit", "code": code})


if __name__ == "__main__":
    main()

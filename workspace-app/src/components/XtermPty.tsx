import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RefreshCw, Square } from 'lucide-react';
import { withToken } from '../api';

interface Props {
  ptyKey: string;
  cwd: string;
  machine?: string;
  mode: 'resume' | 'cli' | 'shell';
  tool?: string;
  sessionId?: string;
  model?: string;
  minHeight?: number;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function XtermPty({ ptyKey, cwd, machine, mode, tool = '', sessionId = '', model = '', minHeight = 320 }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'exited' | 'error'>('connecting');
  const [cmdLabel, setCmdLabel] = useState('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [nonce, setNonce] = useState(0);
  const freshRef = useRef(false);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !cwd) return;

    setStatus('connecting');
    setErrMsg('');
    setExitCode(null);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, Menlo, monospace",
      theme: {
        background: '#0b0d11',
        foreground: '#e4e8f0',
        cursor: '#5fb8a4',
        selectionBackground: 'rgba(95, 184, 164, 0.32)',
        black: '#1a1d24',
        red: '#e87070',
        green: '#8ad6a3',
        yellow: '#e5c063',
        blue: '#7d9bf0',
        magenta: '#c59be8',
        cyan: '#5fb8a4',
        white: '#e4e8f0',
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch {}

    const params = new URLSearchParams({
      key: ptyKey,
      cwd,
      mode,
      cols: String(term.cols || 100),
      rows: String(term.rows || 30),
    });
    if (machine) params.set('machine', machine);
    if (tool) params.set('tool', tool);
    if (sessionId) params.set('sessionId', sessionId);
    if (model) params.set('model', model);
    if (freshRef.current) {
      params.set('fresh', '1');
      freshRef.current = false;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}${withToken(`/ws/pty?${params.toString()}`)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      try {
        fit.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {}
      term.focus();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.type === 'ready') {
          setCmdLabel(msg.cmd || '');
          if (msg.exited) setStatus('exited');
        } else if (msg.type === 'out' && msg.data) {
          term.write(b64ToBytes(msg.data));
        } else if (msg.type === 'exit') {
          setStatus('exited');
          setExitCode(typeof msg.code === 'number' ? msg.code : 0);
          term.writeln(`\r\n\x1b[90m[processo encerrado · exit ${msg.code ?? 0}]\x1b[0m`);
        }
      } catch {}
    };

    ws.onerror = () => {
      setStatus('error');
      setErrMsg('Não foi possível abrir o WebSocket PTY (verifique se a pasta é autorizada e se o servidor está ativo).');
    };

    ws.onclose = () => {
      setStatus((cur) => (cur === 'open' || cur === 'connecting' ? 'exited' : cur));
    };

    const dataDisp = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'in', data }));
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataDisp.dispose();
      try { ws.close(); } catch {}
      wsRef.current = null;
      term.dispose();
    };
  }, [ptyKey, cwd, machine, mode, tool, sessionId, model, nonce]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: '#111318',
          borderBottom: '1px solid var(--border)',
          fontSize: 11.5,
          flexShrink: 0,
        }}
      >
        <span className={`badge ${status === 'open' ? 'working' : status === 'error' ? 'permission' : ''}`}>
          {status === 'open'
            ? '● PTY ao vivo'
            : status === 'connecting'
              ? 'conectando…'
              : status === 'error'
                ? 'erro PTY'
                : `encerrado${exitCode !== null ? ` (${exitCode})` : ''}`}
        </span>
        <span className="mono ell" style={{ flex: 1, color: 'var(--muted)' }} title={cmdLabel || cwd}>
          {cmdLabel || cwd}
        </span>
        <button
          className="btn btn-sm"
          title="Reiniciar processo no terminal"
          onClick={() => { freshRef.current = true; setNonce((n) => n + 1); }}
        >
          <RefreshCw size={11} /> Reiniciar
        </button>
        {status === 'open' && (
          <button
            className="btn btn-sm btn-danger"
            title="Encerrar processo PTY"
            onClick={() => {
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'kill' }));
              }
            }}
          >
            <Square size={11} /> Encerrar
          </button>
        )}
      </div>

      {errMsg && (
        <div style={{ padding: '8px 12px', background: 'rgba(232,112,112,.12)', color: '#f6b3b3', fontSize: 12 }}>
          {errMsg}
        </div>
      )}

      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight,
          background: '#0b0d11',
          padding: 6,
          overflow: 'hidden',
        }}
      />
    </div>
  );
}

import { useRef, useState } from 'react';
import { Play, Terminal, Trash2 } from 'lucide-react';
import { api } from '../api';

interface Props {
  cwd: string;
  machine?: string;
  onNotify: (msg: string, err?: boolean) => void;
}

interface Entry {
  id: number;
  command: string;
  ok: boolean;
  code: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  redacted?: boolean;
}

const QUICK_CMDS = ['git status -s', 'git log -n 8 --oneline', 'npm test', 'dir'];

export function TerminalPane({ cwd, machine, onNotify }: Props) {
  const [cmd, setCmd] = useState('');
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement | null>(null);

  async function run(rawCmd?: string) {
    const command = (rawCmd ?? cmd).trim();
    if (!command || running) return;
    setRunning(true);
    setCmd('');
    setHistory((h) => [command, ...h.filter((x) => x !== command)].slice(0, 40));
    setHistIdx(-1);
    try {
      const r = await api.execTerminal({ cwd, machine, command });
      setEntries((prev) => [
        ...prev,
        {
          id: Date.now() + Math.random(),
          command,
          ok: r.ok,
          code: r.code,
          durationMs: r.durationMs,
          stdout: r.stdout,
          stderr: r.stderr,
          timedOut: r.timedOut,
          redacted: r.redacted,
        },
      ]);
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 30);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="badge mono"><Terminal size={12} /> {machine ? `${machine}: ` : ''}{cwd}</span>
        {QUICK_CMDS.map((q) => (
          <button key={q} className="btn btn-sm" disabled={running} onClick={() => run(q)}>
            {q}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {entries.length > 0 && (
          <button className="btn btn-sm" onClick={() => setEntries([])}>
            <Trash2 size={12} /> Limpar
          </button>
        )}
      </div>

      <div
        className="mono"
        style={{
          flex: 1,
          minHeight: 280,
          overflowY: 'auto',
          background: '#0d0f13',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 12,
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      >
        {entries.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>
            Terminal integrado protegido por allowlist do projeto. Digite um comando abaixo ou use um atalho acima.
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.id} style={{ marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid #1d212b' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ color: e.ok ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>$ {e.command}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  exit {e.code} · {e.durationMs}ms{e.timedOut ? ' · timeout' : ''}{e.redacted ? ' · 🔒 segredos ocultados' : ''}
                </span>
              </div>
              {e.stdout && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e6e8ec' }}>{e.stdout}</pre>}
              {e.stderr && <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#f29a9a' }}>{e.stderr}</pre>}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(ev) => { ev.preventDefault(); run(); }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          className="inp mono"
          value={cmd}
          disabled={running}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const next = Math.min(history.length - 1, histIdx + 1);
              setHistIdx(next);
              setCmd(history[next]);
            } else if (e.key === 'ArrowDown' && histIdx >= 0) {
              e.preventDefault();
              const next = histIdx - 1;
              setHistIdx(next);
              setCmd(next >= 0 ? history[next] : '');
            }
          }}
          placeholder="Digite um comando (Enter executa, ↑/↓ histórico)…"
        />
        <button className="btn btn-primary" type="submit" disabled={running || !cmd.trim()}>
          <Play size={14} /> {running ? 'Rodando…' : 'Executar'}
        </button>
      </form>
    </div>
  );
}

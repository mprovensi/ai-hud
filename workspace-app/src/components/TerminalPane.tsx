import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { XtermPty } from './XtermPty';

interface Props {
  cwd: string;
  machine?: string;
  onNotify: (msg: string, err?: boolean) => void;
}

type LauncherPreset = {
  id: string;
  label: string;
  mode: 'shell' | 'cli';
  tool?: string;
};

const PRESETS: LauncherPreset[] = [
  { id: 'shell', label: 'PowerShell / Shell', mode: 'shell' },
  { id: 'claude', label: 'Claude Code CLI', mode: 'cli', tool: 'Claude Code' },
  { id: 'codex', label: 'Codex CLI', mode: 'cli', tool: 'Codex' },
  { id: 'gemini', label: 'Gemini (agy)', mode: 'cli', tool: 'Gemini' },
];

export function TerminalPane({ cwd, machine }: Props) {
  const [preset, setPreset] = useState<LauncherPreset>(PRESETS[0]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="badge mono"><Terminal size={12} /> {machine ? `${machine}: ` : ''}{cwd}</span>
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.id} className={preset.id === p.id ? 'on' : ''} onClick={() => setPreset(p)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 420,
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <XtermPty
          ptyKey={`stage:${machine || 'local'}:${cwd}:${preset.id}`}
          cwd={cwd}
          machine={machine}
          mode={preset.mode}
          tool={preset.tool}
          minHeight={380}
        />
      </div>
    </div>
  );
}

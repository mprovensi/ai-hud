import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface PaletteAction {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}

export function CommandPalette({ open, actions, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const list = q
    ? actions.filter((a) => `${a.group} ${a.label} ${a.hint || ''}`.toLowerCase().includes(q))
    : actions;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560, padding: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 10px', borderBottom: '1px solid var(--border)' }}>
          <Search size={16} color="#8f96a6" />
          <input
            ref={inputRef}
            style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', fontSize: 14 }}
            placeholder="Ir para projeto, documento, memória ou ação…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              if (e.key === 'Enter' && list[idx]) { list[idx].run(); onClose(); }
            }}
          />
          <span className="kbd">ESC</span>
        </div>
        <div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 8 }}>
          {list.map((a, i) => (
            <button
              key={a.id}
              className={`sb-item ${i === idx ? 'active' : ''}`}
              onClick={() => { a.run(); onClose(); }}
            >
              <span className="badge" style={{ fontSize: 10 }}>{a.group}</span>
              <span className="ell" style={{ flex: 1 }}>{a.label}</span>
              {a.hint && <span className="meta">{a.hint}</span>}
            </button>
          ))}
          {!list.length && <div className="empty" style={{ padding: 18 }}>Nenhum resultado.</div>}
        </div>
      </div>
    </div>
  );
}

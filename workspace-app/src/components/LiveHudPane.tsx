import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, GitFork, Plus, Send, Square } from 'lucide-react';
import { api } from '../api';
import type { MachineCaps, SessionCard, SessionDetail, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot | null;
  projectTitle?: string;
  binding?: { machine: string; cwd: string } | null;
  draftPrompt?: string;
  onDraftConsumed: () => void;
  onNotify: (msg: string, err?: boolean) => void;
  onPollNow: () => void;
}

export function LiveHudPane({ snapshot, projectTitle, binding, draftPrompt, onDraftConsumed, onNotify, onPollNow }: Props) {
  const [filter, setFilter] = useState<'project' | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  // Novo chat inline
  const [creating, setCreating] = useState(false);
  const [caps, setCaps] = useState<MachineCaps[]>([]);
  const [newMachine, setNewMachine] = useState('');
  const [newTool, setNewTool] = useState('Claude Code');
  const [newModel, setNewModel] = useState('');
  const [newCwd, setNewCwd] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  // Handoff inline
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffTool, setHandoffTool] = useState('Codex');
  const [handoffNote, setHandoffNote] = useState('');

  useEffect(() => {
    if (draftPrompt) {
      setCreating(true);
      setNewPrompt(draftPrompt);
      onDraftConsumed();
    }
  }, [draftPrompt]);

  useEffect(() => {
    if (!creating) return;
    api.getCapabilities().then((r) => {
      setCaps(r.machines || []);
      const prefMachine = binding?.machine || r.machines.find((m) => m.online && Object.keys(m.tools || {}).length > 0)?.name || '';
      setNewMachine(prefMachine);
      const m = r.machines.find((x) => x.name === prefMachine);
      const tools = m ? Object.keys(m.tools || {}) : [];
      if (tools.length && !tools.includes(newTool)) setNewTool(tools[0]);
      setNewCwd(binding?.cwd || (m?.cwds?.[0] ?? ''));
    }).catch(() => {});
  }, [creating, binding]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    const load = () => {
      api.getSession(selectedId).then((d) => {
        if (!cancelled) setDetail(d);
      }).catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 3500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId, snapshot?.version]);

  const allSessions: SessionCard[] = snapshot ? [...snapshot.active, ...snapshot.recent] : [];
  const filtered = filter === 'project' && (projectTitle || binding?.cwd)
    ? allSessions.filter((s) => {
        const p = (s.project || '').toLowerCase();
        const t = (projectTitle || '').toLowerCase();
        const base = (binding?.cwd || '').split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || '';
        return (t && p.includes(t)) || (base && p === base);
      })
    : allSessions;

  async function sendReply() {
    if (!detail || !replyText.trim() || sending) return;
    setSending(true);
    try {
      await api.replySession({ id: detail.id, key: detail.key || detail.id, tool: detail.tool, text: replyText.trim() });
      setReplyText('');
      onNotify('Mensagem enviada.');
      onPollNow();
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  async function startNew() {
    if (!newPrompt.trim() || sending) return;
    setSending(true);
    try {
      const r = await api.newSession({
        machine: newMachine,
        tool: newTool,
        model: newModel,
        cwd: newTool === 'Ollama' ? '' : newCwd,
        prompt: newPrompt.trim(),
      });
      setCreating(false);
      setNewPrompt('');
      onPollNow();
      if (r.id) setSelectedId(r.id);
      onNotify('Nova sessão iniciada.');
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  async function doHandoff() {
    if (!detail || sending) return;
    setSending(true);
    try {
      const r = await api.handoff({ id: detail.id, targetTool: handoffTool, note: handoffNote });
      setHandoffOpen(false);
      setHandoffNote('');
      onPollNow();
      if (r.id) setSelectedId(r.id);
      onNotify(`Handoff criado para ${r.tool}.`);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  const chosenM = caps.find((m) => m.name === newMachine);
  const availTools = chosenM ? Object.keys(chosenM.tools || {}) : [];
  const availModels = chosenM?.tools?.[newTool]?.models || [];

  return (
    <aside className="hud-pane">
      <div className="hud-head">
        {selectedId || creating ? (
          <button className="btn btn-sm btn-icon" onClick={() => { setSelectedId(''); setCreating(false); setHandoffOpen(false); }}>
            <ArrowLeft size={14} />
          </button>
        ) : null}
        <strong style={{ fontSize: 13 }}>
          {creating ? 'Nova sessão' : detail ? detail.project : 'Sessões ao vivo'}
        </strong>
        {!selectedId && !creating && (
          <div className="seg" style={{ marginLeft: 'auto' }}>
            <button className={filter === 'project' ? 'on' : ''} onClick={() => setFilter('project')}>Projeto</button>
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>Todas</button>
          </div>
        )}
        {!creating && (
          <button className="btn btn-sm btn-primary" style={{ marginLeft: selectedId ? 'auto' : 6 }} onClick={() => { setSelectedId(''); setCreating(true); }}>
            <Plus size={13} /> Nova
          </button>
        )}
      </div>

      <div className="hud-scroll">
        {creating ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="field">
              <label>Máquina</label>
              <select className="sel" value={newMachine} onChange={(e) => { setNewMachine(e.target.value); setNewModel(''); }}>
                {caps.map((m) => (
                  <option key={m.name} value={m.name} disabled={!m.online}>
                    {m.name} {!m.online ? '(offline)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>IA</label>
              <select className="sel" value={newTool} onChange={(e) => { setNewTool(e.target.value); setNewModel(''); }}>
                {availTools.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {availModels.length > 0 && (
              <div className="field">
                <label>Modelo</label>
                <select className="sel" value={newModel} onChange={(e) => setNewModel(e.target.value)}>
                  {availModels.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
                </select>
              </div>
            )}
            {newTool !== 'Ollama' && (
              <div className="field">
                <label>Pasta do projeto</label>
                <input className="inp mono" value={newCwd} onChange={(e) => setNewCwd(e.target.value)} placeholder="Caminho da pasta…" />
              </div>
            )}
            <div className="field">
              <label>Mensagem inicial</label>
              <textarea
                className="ta"
                rows={4}
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') startNew(); }}
                placeholder="Descreva a tarefa (Ctrl+Enter para enviar)…"
              />
            </div>
            <button className="btn btn-primary" disabled={sending || !newPrompt.trim()} onClick={startNew}>
              {sending ? 'Iniciando…' : 'Iniciar sessão'}
            </button>
          </div>
        ) : detail ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className={`badge ${detail.state}`}>{detail.state}</span>
              <span className="badge">{detail.tool}</span>
              {detail.machine && <span className="badge">{detail.machine}</span>}
              {detail.canStop && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={async () => {
                    try { const r = await api.stopTurn(detail.id); onNotify(r.message, !r.ok); onPollNow(); }
                    catch (e) { onNotify((e as Error).message, true); }
                  }}
                >
                  <Square size={11} /> Parar
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setHandoffOpen(!handoffOpen)}>
                <GitFork size={12} /> Handoff
              </button>
            </div>

            {handoffOpen && (
              <div className="card-item" style={{ borderColor: 'var(--accent)' }}>
                <div className="field">
                  <label>Continuar em (Cross-IA)</label>
                  <select className="sel" value={handoffTool} onChange={(e) => setHandoffTool(e.target.value)}>
                    {['Claude Code', 'Codex', 'Gemini', 'Ollama'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <textarea className="ta" rows={2} value={handoffNote} onChange={(e) => setHandoffNote(e.target.value)} placeholder="Nota opcional…" />
                <div className="card-actions">
                  <button className="btn btn-sm btn-primary" disabled={sending} onClick={doHandoff}>Criar Handoff</button>
                  <button className="btn btn-sm" onClick={() => setHandoffOpen(false)}>Cancelar</button>
                </div>
              </div>
            )}

            <div className="convo-msgs">
              {(detail.history && detail.history.length ? detail.history : [
                ...(detail.lastPrompt ? [{ role: 'user' as const, content: detail.lastPrompt }] : []),
                ...(detail.lastReply ? [{ role: 'assistant' as const, content: detail.lastReply }] : []),
              ]).map((m, i) => (
                <div key={i} className={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>
                  {m.role === 'user' ? (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  ) : (
                    <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <textarea
                className="ta"
                rows={2}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply(); }}
                placeholder="Responder (Ctrl+Enter)…"
              />
              <button className="btn btn-primary" disabled={sending || !replyText.trim()} onClick={sendReply} title="Enviar">
                <Send size={14} />
              </button>
            </div>
          </div>
        ) : (
          <div>
            {filtered.slice(0, 24).map((s) => {
              const pct = s.contextWindow && s.context ? Math.round((s.context / s.contextWindow) * 100) : 0;
              return (
                <button key={s.id} className="sess-card" onClick={() => setSelectedId(s.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <strong className="ell" style={{ flex: 1, fontSize: 13 }}>{s.project || 'Sessão'}</strong>
                    <span className={`badge ${s.state}`}>{s.state}</span>
                  </div>
                  <div className="ell" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
                    {s.title || s.lastPrompt || '(sem título)'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
                    <span>{s.tool}</span>
                    {s.machine && <span>· {s.machine}</span>}
                    {pct > 0 && <span>· ctx {pct}%</span>}
                  </div>
                </button>
              );
            })}
            {!filtered.length && (
              <div className="empty">
                {filter === 'project' ? 'Nenhuma sessão encontrada para este projeto. Alterne para "Todas" ou clique em "+ Nova".' : 'Nenhuma sessão recente.'}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

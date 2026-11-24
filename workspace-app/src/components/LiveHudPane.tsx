import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  Check,
  GitFork,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  Send,
  ShieldAlert,
  Square,
  Star,
  Terminal,
  Volume2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { SessionCard, SessionDetail, Snapshot } from '../types';

interface Props {
  snapshot: Snapshot | null;
  projectId?: string;
  projectTitle?: string;
  binding?: { machine: string; cwd: string } | null;
  draftPrompt?: string;
  onDraftConsumed: () => void;
  onOpenNewSession: (initialPrompt?: string) => void;
  onNotify: (msg: string, err?: boolean) => void;
  onPollNow: () => void;
  width?: number;
}

interface TermCmdEntry {
  id: number;
  command: string;
  ok: boolean;
  code: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function projectMatch(s: SessionCard, binding?: { machine: string; cwd: string } | null, title?: string): boolean {
  if (!binding && !title) return true;
  const folder = binding?.cwd ? binding.cwd.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() : '';
  const proj = (s.project || '').toLowerCase();
  if (folder && (proj === folder || proj.includes(folder))) return true;
  if (title && proj && title.toLowerCase().includes(proj)) return true;
  return false;
}

export function LiveHudPane({
  snapshot,
  projectId,
  projectTitle,
  binding,
  draftPrompt,
  onDraftConsumed,
  onOpenNewSession,
  onNotify,
  onPollNow,
  width,
}: Props) {
  const [filter, setFilter] = useState<'project' | 'all'>(binding || projectTitle ? 'project' : 'all');
  const [selectedId, setSelectedId] = useState<string>('');
  const [viewMode, setViewMode] = useState<'conversation' | 'terminal'>('conversation');
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);

  // Handoff inline
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffTool, setHandoffTool] = useState('Claude Code');
  const [handoffNote, setHandoffNote] = useState('');
  const [skills, setSkills] = useState<{ cmd: string; name: string; description: string; source: string }[]>([]);
  const [uploading, setUploading] = useState(false);

  // Terminal mode state (per session)
  const [termCmd, setTermCmd] = useState('');
  const [termRunning, setTermRunning] = useState(false);
  const [termRuns, setTermRuns] = useState<Record<string, TermCmdEntry[]>>({});

  // Auto-scroll refs (Conversation & Terminal)
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const termScrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const prevProjectIdRef = useRef<string | undefined>(projectId);

  // Item 4: Ao clicar em um projeto na barra esquerda, já alterna a lista de sessões para as do projeto
  useEffect(() => {
    if (projectId === prevProjectIdRef.current) return;
    prevProjectIdRef.current = projectId;
    if (projectId) {
      setSelectedId('');
      setDetail(null);
      setFilter(binding || projectTitle ? 'project' : 'all');
    }
  }, [projectId, binding, projectTitle]);

  // Recebe prompt enviado a partir de um card
  useEffect(() => {
    if (!draftPrompt) return;
    if (selectedId) {
      setViewMode('conversation');
      setReplyText(draftPrompt);
    } else {
      onOpenNewSession(draftPrompt);
    }
    onDraftConsumed();
  }, [draftPrompt, selectedId, onDraftConsumed, onOpenNewSession]);

  // Carrega detalhes da sessão selecionada e acompanha atualizações do snapshot
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      prevMsgCountRef.current = 0;
      return;
    }
    stickBottomRef.current = true;
    let alive = true;
    api.getSession(selectedId)
      .then((d) => { if (alive) setDetail(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [selectedId, snapshot?.version]);

  const messages = useMemo(() => {
    if (!detail) return [];
    if (detail.history && detail.history.length) return detail.history;
    const out: { role: 'user' | 'assistant'; content: string; at?: number; tools?: string[] }[] = [];
    if (detail.lastPrompt) out.push({ role: 'user', content: detail.lastPrompt });
    if (detail.lastReply) out.push({ role: 'assistant', content: detail.lastReply });
    return out;
  }, [detail]);

  // Item 3: Rola automaticamente para a mensagem mais recente ao abrir sessão ou receber novas mensagens
  useEffect(() => {
    if (!selectedId || viewMode !== 'conversation') return;
    const el = chatScrollRef.current;
    if (!el) return;
    const count = messages.length + (detail?.state === 'working' ? 1 : 0);
    const shouldScroll = stickBottomRef.current || prevMsgCountRef.current === 0 || count > prevMsgCountRef.current;
    prevMsgCountRef.current = count;
    if (shouldScroll) {
      window.requestAnimationFrame(() => {
        if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      });
    }
  }, [selectedId, viewMode, messages.length, detail?.state, detail?.lastReply]);

  useEffect(() => {
    if (!selectedId || viewMode !== 'terminal') return;
    const el = termScrollRef.current;
    if (!el) return;
    window.requestAnimationFrame(() => {
      if (termScrollRef.current) termScrollRef.current.scrollTop = termScrollRef.current.scrollHeight;
    });
  }, [selectedId, viewMode, messages.length, termRuns]);

  const allSessions = useMemo(() => [...(snapshot?.active || []), ...(snapshot?.recent || []).slice(0, 15)], [snapshot]);
  const projectSessions = useMemo(
    () => allSessions.filter((s) => projectMatch(s, binding, projectTitle)),
    [allSessions, binding, projectTitle],
  );
  const visible = filter === 'project' && (binding || projectTitle) ? projectSessions : allSessions;

  async function sendReply() {
    if (!detail || !replyText.trim() || sending) return;
    setSending(true);
    stickBottomRef.current = true;
    try {
      await api.replySession({ id: detail.id, key: detail.key || '', tool: detail.tool, text: replyText.trim() });
      setReplyText('');
      onNotify('Mensagem enviada à sessão.');
      onPollNow();
      api.getSession(detail.id).then(setDetail).catch(() => {});
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
      onNotify(`Handoff criado para ${r.tool}!`);
      onPollNow();
      if (r.id) setSelectedId(r.id);
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  async function runSessionTerminal(rawCmd?: string) {
    const command = (rawCmd ?? termCmd).trim();
    if (!detail || !command || termRunning) return;
    const targetCwd = detail.cwd || binding?.cwd || '';
    if (!targetCwd) {
      onNotify('Esta sessão não tem pasta (cwd) registrada para executar comandos.', true);
      return;
    }
    setTermRunning(true);
    setTermCmd('');
    try {
      const r = await api.execTerminal({ cwd: targetCwd, machine: detail.machine || binding?.machine, command });
      setTermRuns((prev) => ({
        ...prev,
        [detail.id]: [
          ...(prev[detail.id] || []),
          { id: Date.now(), command, ok: r.ok, code: r.code, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr },
        ],
      }));
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setTermRunning(false);
    }
  }

  const sessionTermEntries = detail ? (termRuns[detail.id] || []) : [];

  return (
    <aside className="hud-pane" style={width ? { width } : undefined}>
      {/* Top Header of Right Pane */}
      <div className="hud-head">
        {selectedId ? (
          <>
            <button className="btn btn-sm btn-icon" onClick={() => setSelectedId('')} title="Voltar à lista de sessões">
              <ArrowLeft size={14} />
            </button>
            <strong className="ell" style={{ flex: 1, fontSize: 13 }}>
              {detail?.pinned ? '★ ' : ''}{detail?.alias || detail?.project || 'Sessão'}
            </strong>
            {/* Item 7: Switcher Mr. Mak style Conversation | Terminal */}
            <div className="seg" role="tablist" aria-label="Modo da sessão">
              <button
                className={viewMode === 'conversation' ? 'on' : ''}
                onClick={() => setViewMode('conversation')}
                title="Visualização de conversa estruturada"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <MessageSquare size={11} /> Conversa
              </button>
              <button
                className={viewMode === 'terminal' ? 'on' : ''}
                onClick={() => setViewMode('terminal')}
                title="Visualização de terminal da sessão"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Terminal size={11} /> Terminal
              </button>
            </div>
          </>
        ) : (
          <>
            <strong style={{ fontSize: 13 }}>Sessões</strong>
            <div className="seg" style={{ marginLeft: 4 }}>
              <button
                className={filter === 'project' ? 'on' : ''}
                disabled={!binding && !projectTitle}
                onClick={() => setFilter('project')}
                title={projectTitle ? `Sessões de ${projectTitle}` : 'Selecione um projeto'}
              >
                Projeto{binding || projectTitle ? ` (${projectSessions.length})` : ''}
              </button>
              <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
                Todas ({allSessions.length})
              </button>
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm btn-primary" onClick={() => onOpenNewSession()} title="Abrir gaveta lateral para nova conversa">
              <Plus size={13} /> Nova
            </button>
          </>
        )}
      </div>

      {/* Body: Session List OR Active Session (Conversation | Terminal) */}
      {!selectedId ? (
        <div className="hud-scroll">
          {filter === 'project' && projectTitle && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '2px 2px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="ell">Filtrado por <b style={{ color: 'var(--text)' }}>{projectTitle}</b></span>
              {visible.length === 0 && (
                <button className="btn btn-sm" onClick={() => onOpenNewSession()}>
                  <Plus size={11} /> Iniciar aqui
                </button>
              )}
            </div>
          )}
          {visible.length === 0 ? (
            <div className="empty">
              Nenhuma sessão {filter === 'project' ? 'neste projeto' : 'ativa'}.
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-primary btn-sm" onClick={() => onOpenNewSession()}>
                  <Plus size={13} /> Nova conversa
                </button>
              </div>
            </div>
          ) : (
            visible.map((s) => (
              <button key={s.id} className={`sess-card ${selectedId === s.id ? 'active' : ''}`} onClick={() => setSelectedId(s.id)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <strong className="ell" style={{ flex: 1, fontSize: 13 }}>
                    {s.pinned ? '★ ' : ''}{s.alias || s.project}
                  </strong>
                  {s.group && <span className="badge" style={{ fontSize: 10 }}>{s.group}</span>}
                  <span className={`badge ${s.state}`}>{s.state}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
                  <span>{s.tool}</span>
                  {s.machine && <span>· {s.machine}</span>}
                  {!!s.contextWindow && s.contextWindow > 0 && <span>· ctx {Math.round(((s.context || 0) / s.contextWindow) * 100)}%</span>}
                </div>
                {(s.lastReply || s.title) && (
                  <div className="ell" style={{ fontSize: 12, color: '#bcc3d2' }}>{s.lastReply || s.title}</div>
                )}
              </button>
            ))
          )}
        </div>
      ) : !detail ? (
        <div className="empty">Carregando sessão…</div>
      ) : (
        <div className="hud-chat-wrap">
          {/* Action / metadata sub-bar */}
          <div className="hud-chat-bar">
            <span className={`badge ${detail.state}`}>{detail.state}</span>
            <span className="badge">{detail.tool}</span>
            {detail.machine && <span className="badge">{detail.machine}</span>}
            {!!detail.contextWindow && detail.contextWindow > 0 && (
              <span className="badge">ctx {Math.round(((detail.context || 0) / detail.contextWindow) * 100)}%</span>
            )}
            <div style={{ flex: 1 }} />
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
            <button
              className="btn btn-sm btn-icon"
              title={detail.pinned ? 'Desfixar sessão' : 'Fixar sessão no topo'}
              onClick={async () => {
                try {
                  const next = !detail.pinned;
                  await api.setSessionMeta({ id: detail.id, pinned: next });
                  setDetail({ ...detail, pinned: next });
                  onPollNow();
                  onNotify(next ? 'Sessão fixada.' : 'Sessão desfixada.');
                } catch (e) { onNotify((e as Error).message, true); }
              }}
            >
              <Star size={12} fill={detail.pinned ? '#e5c063' : 'none'} color={detail.pinned ? '#e5c063' : 'currentColor'} />
            </button>
            <button className="btn btn-sm" onClick={() => setHandoffOpen(!handoffOpen)} title="Resumir e continuar em outra sessão/IA">
              <GitFork size={12} /> Handoff
            </button>
            {detail.lastReply && (
              <button
                className="btn btn-sm btn-icon"
                title="Ouvir última resposta (TTS local)"
                onClick={async () => {
                  try {
                    const r = await api.speakText(detail.lastReply || '');
                    const audio = new Audio(`data:${r.contentType || 'audio/wav'};base64,${r.audioBase64}`);
                    await audio.play();
                  } catch (e) {
                    onNotify((e as Error).message, true);
                  }
                }}
              >
                <Volume2 size={12} />
              </button>
            )}
          </div>

          {/* Handoff inline drawer */}
          {handoffOpen && (
            <div style={{ padding: 10, borderBottom: '1px solid var(--border)', background: '#161a22' }}>
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

          {/* MODE 1: CONVERSATION (Traditional AI Chat with fixed bottom input & auto-scroll) */}
          {viewMode === 'conversation' ? (
            <>
              <div
                className="hud-chat-scroll"
                ref={chatScrollRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
                }}
              >
                {detail.permission && (
                  <div className="conflict-box" style={{ marginBottom: 10 }}>
                    <h4 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ShieldAlert size={14} /> Permissão · {detail.permission.tool}
                    </h4>
                    {detail.permission.summary && (
                      <pre className="mono" style={{ fontSize: 11.5, margin: '6px 0 8px', whiteSpace: 'pre-wrap' }}>
                        {detail.permission.summary}
                      </pre>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={async () => {
                          try {
                            await api.decidePermission({ id: detail.permission!.id, decision: 'allow', session: detail.id });
                            onNotify('Permissão concedida.');
                            onPollNow();
                          } catch (e) { onNotify((e as Error).message, true); }
                        }}
                      >
                        <Check size={12} /> Permitir
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={async () => {
                          try {
                            await api.decidePermission({ id: detail.permission!.id, decision: 'deny', session: detail.id });
                            onNotify('Permissão negada.');
                            onPollNow();
                          } catch (e) { onNotify((e as Error).message, true); }
                        }}
                      >
                        <X size={12} /> Negar
                      </button>
                    </div>
                  </div>
                )}

                <div className="convo-msgs">
                  {messages.length === 0 ? (
                    <div className="empty">Sem mensagens registradas ainda.</div>
                  ) : (
                    messages.map((m, i) => (
                      <div key={i} className={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>
                        {m.role === 'assistant' && m.tools && m.tools.length > 0 && (
                          <div className="tool-pills">
                            {m.tools.slice(0, 8).map((t, ti) => (
                              <span key={ti} className="tool-pill">{t}</span>
                            ))}
                            {m.tools.length > 8 && <span className="tool-pill">+{m.tools.length - 8}</span>}
                          </div>
                        )}
                        {m.role === 'user' ? (
                          <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                        ) : (
                          <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                        )}
                      </div>
                    ))
                  )}
                  {detail.state === 'working' && (
                    <div className="msg ai" style={{ borderStyle: 'dashed', color: 'var(--ok)', fontSize: 12.5 }}>
                      ● {detail.lastTool ? `executando ${detail.lastTool}…` : 'pensando…'}
                    </div>
                  )}
                </div>
              </div>

              {/* Fixed Bottom Reply Composer */}
              <div className="hud-chat-footer">
                {replyText.startsWith('/') && skills.length > 0 && (
                  <div style={{ border: '1px solid var(--border-hi)', borderRadius: 8, background: '#111318', overflow: 'hidden' }}>
                    {skills
                      .filter((sk) => sk.cmd.toLowerCase().startsWith(replyText.trim().toLowerCase()))
                      .slice(0, 6)
                      .map((sk) => (
                        <button
                          key={sk.cmd}
                          className="sb-item"
                          style={{ margin: 0, borderRadius: 0 }}
                          onClick={() => setReplyText(`${sk.cmd} `)}
                        >
                          <strong className="mono">{sk.cmd}</strong>
                          <span className="ell" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sk.description}</span>
                        </button>
                      ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                  <textarea
                    className="ta"
                    rows={2}
                    value={replyText}
                    onChange={(e) => {
                      const v = e.target.value;
                      setReplyText(v);
                      if (v.startsWith('/') && !skills.length) {
                        api.getSkills(detail.cwd || '').then((r) => setSkills(r.skills || [])).catch(() => {});
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    placeholder="Responder (Enter envia, Shift+Enter quebra linha, / skills)…"
                  />
                  <label className="btn btn-icon" title="Anexar imagem" style={{ height: 36 }}>
                    <Paperclip size={14} />
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      disabled={uploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setUploading(true);
                        const rd = new FileReader();
                        rd.onload = async () => {
                          try {
                            const r = await api.uploadAttachment({
                              id: detail.id,
                              fileName: file.name,
                              base64Data: String(rd.result || ''),
                            });
                            setReplyText((prev) => `${prev ? `${prev.trimEnd()}\n` : ''}[Imagem anexada: ${r.path}]\n`);
                            onNotify(`Imagem anexada: ${r.name}`);
                          } catch (err) {
                            onNotify((err as Error).message, true);
                          } finally {
                            setUploading(false);
                          }
                        };
                        rd.readAsDataURL(file);
                      }}
                    />
                  </label>
                  <button
                    className="btn btn-primary btn-icon"
                    style={{ height: 36, width: 38 }}
                    disabled={sending || !replyText.trim()}
                    onClick={sendReply}
                    title="Enviar resposta"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* MODE 2: TERMINAL (Mr. Mak style raw CLI stream + direct command runner in session CWD) */
            <>
              <div className="term-stream" ref={termScrollRef}>
                <div className="term-block" style={{ color: 'var(--muted)' }}>
                  <div># {detail.tool} · {detail.machine || 'local'} · {detail.cwd || '(sem cwd)'}</div>
                  {detail.models && detail.models.length > 0 && <div># modelo: {detail.models.join(', ')}</div>}
                  {detail.files && detail.files.length > 0 && (
                    <div># arquivos tocados ({detail.files.length}): {detail.files.slice(0, 6).map(([f]) => f).join(', ')}</div>
                  )}
                </div>

                {messages.map((m, i) => (
                  <div key={`m-${i}`} className="term-block">
                    {m.role === 'user' ? (
                      <div className="term-prompt">&gt; {m.content}</div>
                    ) : (
                      <>
                        {m.tools && m.tools.length > 0 && (
                          <div className="term-tools">[tools] {m.tools.join(' · ')}</div>
                        )}
                        <pre className="term-out">{m.content}</pre>
                      </>
                    )}
                  </div>
                ))}

                {detail.state === 'working' && (
                  <div className="term-block" style={{ color: 'var(--ok)' }}>
                    ● {detail.lastTool ? `running ${detail.lastTool}…` : 'streaming…'}
                  </div>
                )}

                {sessionTermEntries.map((r) => (
                  <div key={r.id} className="term-block">
                    <div className="term-prompt" style={{ color: r.ok ? 'var(--ok)' : 'var(--danger)' }}>
                      $ {r.command} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(exit {r.code} · {r.durationMs}ms)</span>
                    </div>
                    {r.stdout && <pre className="term-out">{r.stdout}</pre>}
                    {r.stderr && <pre className="term-err">{r.stderr}</pre>}
                  </div>
                ))}
              </div>

              {/* Fixed Bottom Shell Prompt in session CWD */}
              <form
                className="hud-chat-footer"
                onSubmit={(e) => { e.preventDefault(); runSessionTerminal(); }}
              >
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className="mono" style={{ color: 'var(--accent)', fontWeight: 700 }}>$</span>
                  <input
                    className="inp mono"
                    style={{ fontSize: 12.5 }}
                    value={termCmd}
                    disabled={termRunning || !(detail.cwd || binding?.cwd)}
                    onChange={(e) => setTermCmd(e.target.value)}
                    placeholder={detail.cwd || binding?.cwd ? `Comando em ${detail.cwd || binding?.cwd}…` : 'Sessão sem pasta (cwd)'}
                  />
                  <button
                    className="btn btn-primary btn-icon"
                    type="submit"
                    disabled={termRunning || !termCmd.trim() || !(detail.cwd || binding?.cwd)}
                    title="Executar comando na pasta da sessão"
                  >
                    <Play size={13} />
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

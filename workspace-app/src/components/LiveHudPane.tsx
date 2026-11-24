import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Download,
  GitFork,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  Star,
  Terminal,
  Volume2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { ToolIcon } from '../ui';
import { XtermPty } from './XtermPty';
import type { CardStatus, SessionCard, SessionDetail, Snapshot } from '../types';

export interface CardExecIntent {
  entityId: string;
  itemId: string;
  title: string;
  currentStatus: CardStatus;
  nextStatus: CardStatus | null;
  nextLabel: string;
  prompt: string;
}

interface PendingAttach {
  id: string;
  name: string;
  previewUrl: string;
  path?: string;
  uploading: boolean;
  error?: string;
}

interface OutgoingMsg {
  localId: string;
  sessionId: string;
  text: string;
  promptSent: string;
  images: { name: string; path: string; previewUrl: string }[];
  sentAt: number;
  baselineCount: number;
  status: 'sending' | 'sent' | 'failed';
  error?: string;
}

const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|svg|bmp|ico)(?:[?#].*)?$/i;
const ATTACHED_IMG_RE = /^\[Imagem anexada:\s*(.+?)\]\s*$/gm;

function parseAttachedImages(raw: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const text = String(raw || '')
    .replace(ATTACHED_IMG_RE, (_, p) => {
      const clean = String(p || '').trim();
      if (clean) paths.push(clean);
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, paths };
}

function normMsg(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function fmtMsgTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const imgUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Falha ao decodificar imagem'));
      el.src = imgUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas indisponível');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Falha ao converter imagem para PNG'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(imgUrl);
  }
}

function isLocalImageHref(raw?: string): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (!s || /^https?:\/\//i.test(s) || /^data:/i.test(s) || /^javascript:/i.test(s)) return false;
  return IMAGE_PATH_RE.test(s);
}

function safeMarkdownUrl(url: string): string {
  const s = String(url || '').trim();
  if (/^(javascript|vbscript|data:text\/html)/i.test(s)) return '';
  return s;
}

function imageFileName(raw: string): string {
  const clean = raw.split(/[?#]/)[0].replace(/\\/g, '/');
  return clean.split('/').filter(Boolean).pop() || 'imagem.png';
}

interface Props {
  snapshot: Snapshot | null;
  projectId?: string;
  projectTitle?: string;
  binding?: { machine: string; cwd: string } | null;
  focusSessionId?: string;
  onFocusSessionConsumed?: () => void;
  draftPrompt?: string;
  onDraftConsumed: () => void;
  pendingCardExec?: CardExecIntent | null;
  onCancelCardExec?: () => void;
  onCardExecAttached?: (sessionId: string) => void;
  onOpenNewSession: (initialPrompt?: string) => void;
  onNotify: (msg: string, err?: boolean) => void;
  onPollNow: () => void;
  width?: number;
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
  focusSessionId,
  onFocusSessionConsumed,
  draftPrompt,
  onDraftConsumed,
  pendingCardExec = null,
  onCancelCardExec,
  onCardExecAttached,
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
  const [lightboxImg, setLightboxImg] = useState<{ src: string; download: string; name: string } | null>(null);
  const [copiedSrc, setCopiedSrc] = useState('');
  const [pendingImgs, setPendingImgs] = useState<PendingAttach[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [outgoing, setOutgoing] = useState<OutgoingMsg[]>([]);

  // Handoff inline
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffTool, setHandoffTool] = useState('Claude Code');
  const [handoffNote, setHandoffNote] = useState('');
  const [skills, setSkills] = useState<{ cmd: string; name: string; description: string; prompt?: string; source: string }[]>([]);

  // Modo do PTY quando em aba Terminal: CLI nativa da sessão (resume) ou Shell na pasta
  const [ptySubMode, setPtySubMode] = useState<'resume' | 'shell'>('resume');

  // Auto-scroll ref (Conversation)
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const prevProjectIdRef = useRef<string | undefined>(projectId);

  // Item 4: Ao clicar em um projeto na barra esquerda, já alterna a lista de sessões para as do projeto;
  // ao voltar para a tela inicial (sem projeto), volta para "Todas".
  useEffect(() => {
    if (projectId === prevProjectIdRef.current) return;
    prevProjectIdRef.current = projectId;
    if (projectId) {
      setSelectedId('');
      setDetail(null);
      setFilter(binding || projectTitle ? 'project' : 'all');
    } else {
      setFilter('all');
    }
  }, [projectId, binding, projectTitle]);

  useEffect(() => {
    if (!focusSessionId) return;
    setSelectedId(focusSessionId);
    setViewMode('conversation');
    if (onFocusSessionConsumed) onFocusSessionConsumed();
  }, [focusSessionId, onFocusSessionConsumed]);

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

  const sessionOutgoing = useMemo(
    () => outgoing.filter((m) => m.sessionId === selectedId),
    [outgoing, selectedId],
  );

  // Reconcilia mensagens otimistas assim que aparecem no histórico real da sessão (transição sutil para entregue)
  useEffect(() => {
    if (!selectedId || !sessionOutgoing.length) return;
    setOutgoing((prev) =>
      prev.filter((m) => {
        if (m.sessionId !== selectedId || m.status === 'failed' || m.status === 'sending') return true;
        const targetFull = normMsg(m.promptSent);
        const targetText = normMsg(m.text);
        for (let i = Math.max(0, m.baselineCount); i < messages.length; i++) {
          const sm = messages[i];
          if (sm.role === 'user') {
            const c = normMsg(sm.content);
            if (c === targetFull || (targetText && c.includes(targetText))) return false;
          }
        }
        // Fallback: se chegou uma nova resposta da IA após o envio e o histórico cresceu
        if (messages.length > m.baselineCount + 1 && messages[messages.length - 1]?.role === 'assistant') {
          return false;
        }
        return true;
      }),
    );
  }, [selectedId, messages, sessionOutgoing.length]);

  // Poll rápido enquanto há mensagem aguardando confirmação de entrega ou IA trabalhando
  const hasAwaitingDelivery = sessionOutgoing.some((m) => m.status === 'sent');
  useEffect(() => {
    if (!selectedId || viewMode !== 'conversation') return;
    if (!hasAwaitingDelivery && detail?.state !== 'working') return;
    const timer = window.setInterval(() => {
      api.getSession(selectedId).then(setDetail).catch(() => {});
    }, 1800);
    return () => window.clearInterval(timer);
  }, [selectedId, viewMode, hasAwaitingDelivery, detail?.state]);

  // Limpa anexos pendentes ao trocar de sessão
  useEffect(() => {
    setPendingImgs([]);
    setDragOver(false);
  }, [selectedId]);

  // Rola automaticamente para a mensagem mais recente ao abrir sessão, enviar ou receber novas mensagens
  useEffect(() => {
    if (!selectedId || viewMode !== 'conversation') return;
    const el = chatScrollRef.current;
    if (!el) return;
    const count = messages.length + sessionOutgoing.length + (detail?.state === 'working' ? 1 : 0);
    const shouldScroll = stickBottomRef.current || prevMsgCountRef.current === 0 || count > prevMsgCountRef.current;
    prevMsgCountRef.current = count;
    if (shouldScroll) {
      window.requestAnimationFrame(() => {
        if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      });
    }
  }, [selectedId, viewMode, messages.length, sessionOutgoing.length, detail?.state, detail?.lastReply]);

  const allSessions = useMemo(() => [...(snapshot?.active || []), ...(snapshot?.recent || []).slice(0, 15)], [snapshot]);
  const projectSessions = useMemo(
    () => allSessions.filter((s) => projectMatch(s, binding, projectTitle)),
    [allSessions, binding, projectTitle],
  );
  const visible = filter === 'project' && (binding || projectTitle) ? projectSessions : allSessions;

  async function copyImageToClipboard(src: string) {
    if (!src) return;
    try {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('Copiar imagem exige HTTPS ou localhost neste navegador.');
      }
      const res = await fetch(src);
      if (!res.ok) throw new Error('Não foi possível ler a imagem.');
      const blob = await res.blob();
      const png = await blobToPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setCopiedSrc(src);
      onNotify('Imagem copiada para a área de transferência.');
      window.setTimeout(() => {
        setCopiedSrc((cur) => (cur === src ? '' : cur));
      }, 1800);
    } catch (e) {
      onNotify((e as Error).message || 'Falha ao copiar imagem.', true);
    }
  }

  function attachImageFiles(fileList: File[]) {
    if (!detail || !fileList.length) return;
    const imgs = fileList.filter((f) => f && (f.type.startsWith('image/') || IMAGE_PATH_RE.test(f.name)));
    if (!imgs.length) return;
    const sessionId = detail.id;
    imgs.slice(0, 8).forEach((file, idx) => {
      const attId = `att-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
      const fallbackName = file.name && file.name !== 'image.png'
        ? file.name
        : `colada-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      const rd = new FileReader();
      rd.onload = async () => {
        const dataUrl = String(rd.result || '');
        setPendingImgs((prev) => [...prev, { id: attId, name: fallbackName, previewUrl: dataUrl, uploading: true }]);
        try {
          const r = await api.uploadAttachment({
            id: sessionId,
            fileName: fallbackName,
            base64Data: dataUrl,
          });
          setPendingImgs((prev) =>
            prev.map((item) => (item.id === attId ? { ...item, name: r.name, path: r.path, uploading: false } : item)),
          );
        } catch (err) {
          const msg = (err as Error).message || 'Falha no upload';
          setPendingImgs((prev) =>
            prev.map((item) => (item.id === attId ? { ...item, uploading: false, error: msg } : item)),
          );
          onNotify(msg, true);
        }
      };
      rd.readAsDataURL(file);
    });
  }

  const readyImgs = pendingImgs.filter((p) => !p.uploading && !p.error && p.path);
  const uploadingImgs = pendingImgs.some((p) => p.uploading);

  async function dispatchOutgoing(entry: OutgoingMsg) {
    if (!detail) return;
    setSending(true);
    stickBottomRef.current = true;
    try {
      await api.replySession({ id: entry.sessionId, key: detail.key || '', tool: detail.tool, text: entry.promptSent });
      if (pendingCardExec && onCardExecAttached) {
        onCardExecAttached(entry.sessionId);
      }
      setOutgoing((prev) =>
        prev.map((m) => (m.localId === entry.localId ? { ...m, status: 'sent', error: undefined } : m)),
      );
      onPollNow();
      api.getSession(entry.sessionId).then(setDetail).catch(() => {});
      window.setTimeout(() => {
        api.getSession(entry.sessionId).then(setDetail).catch(() => {});
      }, 750);
    } catch (e) {
      const msg = (e as Error).message || 'Falha ao enviar';
      setOutgoing((prev) =>
        prev.map((m) => (m.localId === entry.localId ? { ...m, status: 'failed', error: msg } : m)),
      );
      onNotify(msg, true);
    } finally {
      setSending(false);
    }
  }

  async function sendReply() {
    if (!detail || sending || uploadingImgs) return;
    const cleanText = replyText.trim();
    if (!cleanText && !readyImgs.length) return;
    const imgLines = readyImgs.map((img) => `[Imagem anexada: ${img.path}]`);
    const promptSent = [...imgLines, ...(cleanText ? [cleanText] : [])].join('\n');
    const entry: OutgoingMsg = {
      localId: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: detail.id,
      text: cleanText,
      promptSent,
      images: readyImgs.map((img) => ({ name: img.name, path: img.path!, previewUrl: img.previewUrl })),
      sentAt: Date.now(),
      baselineCount: messages.length,
      status: 'sending',
    };
    setReplyText('');
    setPendingImgs([]);
    setOutgoing((prev) => [...prev, entry]);
    await dispatchOutgoing(entry);
  }

  async function retryOutgoing(entry: OutgoingMsg) {
    setOutgoing((prev) =>
      prev.map((m) => (m.localId === entry.localId ? { ...m, status: 'sending', error: undefined, sentAt: Date.now() } : m)),
    );
    await dispatchOutgoing(entry);
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)', marginBottom: 4 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <ToolIcon tool={s.tool} size={12} />
                    {s.tool}
                  </span>
                  {s.machine && <span>· {s.machine}</span>}
                  {!!s.contextWindow && s.contextWindow > 0 && <span>· ctx {Math.round(((s.context || 0) / s.contextWindow) * 100)}%</span>}
                </div>
                {(s.lastReply || s.title) && (
                  <div className="ell" style={{ fontSize: 12, color: 'var(--ds-text-soft)' }}>{s.lastReply || s.title}</div>
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
            <span className="badge" style={{ gap: 5 }}><ToolIcon tool={detail.tool} size={11} /> {detail.tool}</span>
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
                  {messages.length === 0 && sessionOutgoing.length === 0 ? (
                    <div className="empty">Sem mensagens registradas ainda.</div>
                  ) : (
                    <>
                      {messages.map((m, i) => {
                        const userParsed = m.role === 'user' ? parseAttachedImages(m.content) : null;
                        return (
                          <div key={i} className={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>
                            {m.role === 'assistant' && m.tools && m.tools.length > 0 && (
                              <div className="tool-pills">
                                {m.tools.slice(0, 8).map((t, ti) => (
                                  <span key={ti} className="tool-pill">{t}</span>
                                ))}
                                {m.tools.length > 8 && <span className="tool-pill">+{m.tools.length - 8}</span>}
                              </div>
                            )}
                            {m.role === 'user' && userParsed ? (
                              <>
                                {userParsed.paths.length > 0 && (
                                  <div className="msg-user-imgs">
                                    {userParsed.paths.map((imgPath, pi) => {
                                      const imgSrc = api.sessionImageUrl(detail.id, imgPath, false);
                                      const dlSrc = api.sessionImageUrl(detail.id, imgPath, true);
                                      const name = imageFileName(imgPath);
                                      return (
                                        <div key={`${pi}-${imgPath}`} className="msg-user-img-wrap">
                                          <img
                                            src={imgSrc}
                                            alt={name}
                                            onClick={() => setLightboxImg({ src: imgSrc, download: dlSrc, name })}
                                          />
                                          <div className="msg-user-img-actions">
                                            <button
                                              type="button"
                                              className="msg-user-img-btn"
                                              title="Copiar imagem"
                                              onClick={() => copyImageToClipboard(imgSrc)}
                                            >
                                              {copiedSrc === imgSrc ? <Check size={12} /> : <Copy size={12} />}
                                            </button>
                                            <a
                                              href={dlSrc}
                                              download={name}
                                              className="msg-user-img-btn"
                                              title="Baixar imagem"
                                              style={{ textDecoration: 'none' }}
                                            >
                                              <Download size={12} />
                                            </a>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {userParsed.text && <div style={{ whiteSpace: 'pre-wrap' }}>{userParsed.text}</div>}
                                <div className="msg-meta" title="Entregue à sessão">
                                  {m.at ? <span>{fmtMsgTime(m.at)}</span> : null}
                                  <CheckCheck size={12} className="msg-meta-delivered" />
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="md">
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    urlTransform={safeMarkdownUrl}
                                    components={{
                                      img: ({ src, alt }) => {
                                        const raw = String(src || '');
                                        const isLocal = isLocalImageHref(raw);
                                        const resolvedSrc = isLocal ? api.sessionImageUrl(detail.id, raw, false) : raw;
                                        const dlSrc = isLocal ? api.sessionImageUrl(detail.id, raw, true) : raw;
                                        const name = imageFileName(raw);
                                        return (
                                          <span className="chat-img-card">
                                            <img
                                              src={resolvedSrc}
                                              alt={alt || name}
                                              onClick={() => setLightboxImg({ src: resolvedSrc, download: dlSrc, name })}
                                            />
                                            <span className="chat-img-foot">
                                              <span className="mono ell" style={{ flex: 1 }}>{name}</span>
                                              <button
                                                type="button"
                                                className="btn btn-sm"
                                                title="Copiar imagem"
                                                onClick={() => copyImageToClipboard(resolvedSrc)}
                                              >
                                                {copiedSrc === resolvedSrc ? <Check size={11} /> : <Copy size={11} />}
                                                {copiedSrc === resolvedSrc ? 'Copiada' : 'Copiar'}
                                              </button>
                                              <a href={dlSrc} download={name} className="btn btn-sm" style={{ textDecoration: 'none' }}>
                                                <Download size={11} /> Baixar
                                              </a>
                                            </span>
                                          </span>
                                        );
                                      },
                                      a: ({ href, children }) => {
                                        const raw = String(href || '');
                                        if (isLocalImageHref(raw)) {
                                          const imgSrc = api.sessionImageUrl(detail.id, raw, false);
                                          const dlSrc = api.sessionImageUrl(detail.id, raw, true);
                                          const name = imageFileName(raw);
                                          return (
                                            <span className="chat-img-card">
                                              <img
                                                src={imgSrc}
                                                alt={name}
                                                onClick={() => setLightboxImg({ src: imgSrc, download: dlSrc, name })}
                                              />
                                              <span className="chat-img-foot">
                                                <span className="mono ell" style={{ flex: 1 }}>{name}</span>
                                                <button
                                                  type="button"
                                                  className="btn btn-sm"
                                                  title="Copiar imagem"
                                                  onClick={() => copyImageToClipboard(imgSrc)}
                                                >
                                                  {copiedSrc === imgSrc ? <Check size={11} /> : <Copy size={11} />}
                                                  {copiedSrc === imgSrc ? 'Copiada' : 'Copiar'}
                                                </button>
                                                <a href={dlSrc} download={name} className="btn btn-sm" style={{ textDecoration: 'none' }}>
                                                  <Download size={11} /> {children || 'Baixar'}
                                                </a>
                                              </span>
                                            </span>
                                          );
                                        }
                                        if (/^https?:\/\//i.test(raw)) {
                                          return <a href={raw} target="_blank" rel="noreferrer">{children}</a>;
                                        }
                                        return <code className="mono">{children}</code>;
                                      },
                                    }}
                                  >
                                    {m.content}
                                  </ReactMarkdown>
                                </div>
                                {m.at ? (
                                  <div className="msg-meta" style={{ color: 'var(--ds-muted)' }}>
                                    <span>{fmtMsgTime(m.at)}</span>
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>
                        );
                      })}

                      {sessionOutgoing.map((om) => (
                        <div
                          key={om.localId}
                          className={`msg me ${om.status === 'sending' ? 'msg-sending' : om.status === 'failed' ? 'msg-failed' : 'msg-sent'}`}
                        >
                          {om.images.length > 0 && (
                            <div className="msg-user-imgs">
                              {om.images.map((img, idx) => (
                                <div key={`${om.localId}-${idx}`} className="msg-user-img-wrap">
                                  <img
                                    src={img.previewUrl}
                                    alt={img.name}
                                    onClick={() => setLightboxImg({ src: img.previewUrl, download: img.previewUrl, name: img.name })}
                                  />
                                  <div className="msg-user-img-actions">
                                    <button
                                      type="button"
                                      className="msg-user-img-btn"
                                      title="Copiar imagem"
                                      onClick={() => copyImageToClipboard(img.previewUrl)}
                                    >
                                      {copiedSrc === img.previewUrl ? <Check size={12} /> : <Copy size={12} />}
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {om.text && <div style={{ whiteSpace: 'pre-wrap' }}>{om.text}</div>}
                          <div
                            className={`msg-meta ${om.status === 'failed' ? 'msg-meta-failed' : ''}`}
                            title={
                              om.status === 'sending'
                                ? 'Enviando…'
                                : om.status === 'sent'
                                  ? 'Enviada, aguardando confirmação na sessão'
                                  : om.error || 'Falha ao enviar'
                            }
                          >
                            <span>{fmtMsgTime(om.sentAt)}</span>
                            {om.status === 'sending' && <Clock size={11} />}
                            {om.status === 'sent' && <Check size={12} />}
                            {om.status === 'failed' && <span>falhou</span>}
                          </div>
                          {om.status === 'failed' && (
                            <div className="msg-fail-bar">
                              <span className="ell" style={{ flex: 1 }}>{om.error || 'Erro ao enviar'}</span>
                              <button type="button" className="btn btn-sm" onClick={() => retryOutgoing(om)}>
                                <RotateCcw size={11} /> Reenviar
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-icon"
                                title="Descartar"
                                onClick={() => setOutgoing((prev) => prev.filter((x) => x.localId !== om.localId))}
                              >
                                <X size={11} />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                  {(detail.state === 'working' || hasAwaitingDelivery) && (
                    <div className="msg ai msg-typing">
                      <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                      <span>
                        {detail.state === 'working'
                          ? (detail.lastTool ? `executando ${detail.lastTool}…` : 'pensando…')
                          : 'entregando à sessão…'}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Fixed Bottom Reply Composer */}
              <div
                className={`hud-chat-footer ${dragOver ? 'drag-over' : ''}`}
                onDragOver={(e) => {
                  if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
                    e.preventDefault();
                    if (!dragOver) setDragOver(true);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const files = Array.from(e.dataTransfer?.files || []);
                  if (files.length) attachImageFiles(files);
                }}
              >
                {pendingCardExec && pendingCardExec.nextStatus && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '5px 8px', borderRadius: 7, background: 'rgba(95, 184, 164, .10)', border: '1px solid rgba(95, 184, 164, .35)', marginBottom: 4 }}>
                    <span className="ell" style={{ flex: 1 }}>
                      🎯 Card <b>{pendingCardExec.title}</b> → avançará p/ <b>{pendingCardExec.nextLabel}</b> ao concluir
                    </span>
                    <button className="btn btn-sm btn-icon" style={{ padding: 2, border: 0, background: 'transparent' }} title="Não avançar automaticamente" onClick={onCancelCardExec}>
                      <X size={12} />
                    </button>
                  </div>
                )}
                {pendingImgs.length > 0 && (
                  <div className="chat-attach-strip">
                    {pendingImgs.map((img) => (
                      <div
                        key={img.id}
                        className={`chat-attach-chip ${img.error ? 'err' : ''}`}
                        title={img.error ? `${img.name}: ${img.error}` : img.name}
                      >
                        <img src={img.previewUrl} alt={img.name} />
                        {img.uploading && <div className="chat-attach-busy">…</div>}
                        <button
                          type="button"
                          className="chat-attach-rm"
                          title="Remover imagem"
                          onClick={() => setPendingImgs((prev) => prev.filter((x) => x.id !== img.id))}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
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
                          onClick={() => setReplyText(sk.prompt || `${sk.cmd} `)}
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
                    onPaste={(e) => {
                      const items = Array.from(e.clipboardData?.items || []);
                      const imgFiles: File[] = [];
                      for (const item of items) {
                        if (item.kind === 'file' && item.type.startsWith('image/')) {
                          const f = item.getAsFile();
                          if (f) imgFiles.push(f);
                        }
                      }
                      if (!imgFiles.length) {
                        for (const f of Array.from(e.clipboardData?.files || [])) {
                          if (f.type.startsWith('image/')) imgFiles.push(f);
                        }
                      }
                      if (imgFiles.length) {
                        const plainText = e.clipboardData?.getData('text/plain') || '';
                        if (!plainText) e.preventDefault();
                        attachImageFiles(imgFiles);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    placeholder="Responder (Enter envia, Ctrl+V cola imagem, / skills)…"
                  />
                  <label className="btn btn-icon" title="Anexar ou colar imagem (Ctrl+V)" style={{ height: 36 }}>
                    <Paperclip size={14} />
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      style={{ display: 'none' }}
                      disabled={uploadingImgs}
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        e.target.value = '';
                        if (files.length) attachImageFiles(files);
                      }}
                    />
                  </label>
                  <button
                    className="btn btn-primary btn-icon"
                    style={{ height: 36, width: 38 }}
                    disabled={sending || uploadingImgs || (!replyText.trim() && !readyImgs.length)}
                    onClick={sendReply}
                    title={uploadingImgs ? 'Aguarde o envio da imagem…' : 'Enviar resposta'}
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            /* MODE 2: TERMINAL INTERATIVO REAL (xterm.js + Win32 ConPTY / Unix PTY estilo Mr. Mak) */
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', background: '#101217', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <div className="seg">
                  <button className={ptySubMode === 'resume' ? 'on' : ''} onClick={() => setPtySubMode('resume')}>
                    CLI {detail.tool}
                  </button>
                  <button className={ptySubMode === 'shell' ? 'on' : ''} onClick={() => setPtySubMode('shell')}>
                    Shell
                  </button>
                </div>
                <span className="mono ell" style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
                  {detail.cwd || binding?.cwd || '(sem cwd)'}
                </span>
              </div>
              {detail.cwd || binding?.cwd ? (
                <XtermPty
                  ptyKey={`sess:${detail.id}:${ptySubMode}`}
                  cwd={detail.cwd || binding?.cwd || ''}
                  machine={detail.machine || binding?.machine}
                  mode={ptySubMode}
                  tool={detail.tool}
                  sessionId={detail.id}
                  model={detail.models?.[0] || ''}
                  minHeight={260}
                />
              ) : (
                <div className="empty">Esta sessão não possui pasta (cwd) registrada para abrir o terminal PTY.</div>
              )}
            </div>
          )}
        </div>
      )}

      {lightboxImg && (
        <div className="img-lightbox" onClick={() => setLightboxImg(null)}>
          <img src={lightboxImg.src} alt={lightboxImg.name} onClick={(e) => e.stopPropagation()} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <span className="mono" style={{ fontSize: 12, color: '#d8dee9' }}>{lightboxImg.name}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => copyImageToClipboard(lightboxImg.src)}
            >
              {copiedSrc === lightboxImg.src ? <Check size={13} /> : <Copy size={13} />}
              {copiedSrc === lightboxImg.src ? 'Copiada!' : 'Copiar imagem'}
            </button>
            <a href={lightboxImg.download} download={lightboxImg.name} className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
              <Download size={13} /> Baixar imagem
            </a>
            <button className="btn btn-sm" onClick={() => setLightboxImg(null)}>Fechar</button>
          </div>
        </div>
      )}
    </aside>
  );
}

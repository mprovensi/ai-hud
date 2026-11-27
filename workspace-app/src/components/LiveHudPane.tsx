import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Copy,
  Download,
  GitFork,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  ShieldAlert,
  Slash,
  Square,
  Star,
  Terminal,
  Volume2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { ToolIcon } from '../ui';
import type { CardStatus, MachineCaps, SessionCard, SessionDetail, SessionHistoryMsg, Snapshot } from '../types';

const XtermPty = lazy(() => import('./XtermPty').then((m) => ({ default: m.XtermPty })));

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

function isCanonicalAlias(requestedId: string, resolvedId: string): boolean {
  if (!requestedId || !resolvedId || requestedId === resolvedId) return false;
  const reqPrefix = requestedId.match(/^(m\d+:)/)?.[1] || '';
  const resPrefix = resolvedId.match(/^(m\d+:)/)?.[1] || '';
  if (reqPrefix !== resPrefix) return false;
  const reqBare = requestedId.slice(reqPrefix.length);
  const resBare = resolvedId.slice(resPrefix.length);
  return !!reqBare && resBare.endsWith('-' + reqBare);
}

export interface PendingLaunchMeta {
  tool: string;
  machine: string;
  cwd: string;
  beforeIds: string[];
  startedAt: number;
}

interface Props {
  snapshot: Snapshot | null;
  projectId?: string;
  projectTitle?: string;
  binding?: { machine: string; cwd: string } | null;
  focusSessionId?: string;
  onFocusSessionConsumed?: () => void;
  pendingLaunch?: PendingLaunchMeta | null;
  onPendingLaunchConsumed?: (sessionId?: string) => void;
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
  pendingLaunch = null,
  onPendingLaunchConsumed,
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

  // Handoff inline e troca transparente de IA no composer
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffTool, setHandoffTool] = useState('Claude Code');
  const [handoffModel, setHandoffModel] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [aiPickerOpen, setAiPickerOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ tool: string; model: string } | null>(null);
  const [caps, setCaps] = useState<MachineCaps[] | null>(null);
  const [dismissedQuotaFor, setDismissedQuotaFor] = useState('');
  const [skills, setSkills] = useState<{ cmd: string; name: string; description: string; prompt?: string; source: string }[]>([]);

  // Modo do PTY quando em aba Terminal: CLI nativa da sessão (resume) ou Shell na pasta
  const [ptySubMode, setPtySubMode] = useState<'resume' | 'shell'>('resume');

  // Auto-scroll ref (Conversation) & guarda contra respostas atrasadas de sessão anterior (R08)
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const prevProjectIdRef = useRef<string | undefined>(projectId);
  const selectedIdRef = useRef<string>(selectedId);
  const selectionGenRef = useRef<number>(0);

  // Atualiza identidade/geração da seleção e limpa detail obsoleto ao trocar de sessão
  if (selectedIdRef.current !== selectedId) {
    selectedIdRef.current = selectedId;
    selectionGenRef.current += 1;
  }

  const activeDetail = detail && detail.id === selectedId ? detail : null;

  function fetchSessionDetail(targetId: string, expectedGen?: number) {
    if (!targetId) return Promise.resolve();
    const gen = expectedGen ?? selectionGenRef.current;
    return api.getSession(targetId)
      .then((d) => {
        if (selectedIdRef.current !== targetId || selectionGenRef.current !== gen) return;
        if (d && d.id && d.id !== targetId) {
          // Redirecionamento transparente (outra IA assumiu) OU resolução canônica de ID (ex.: Codex UUID -> rollout-...-UUID)
          if (d.sharedSession || isCanonicalAlias(targetId, d.id)) {
            selectedIdRef.current = d.id;
            setSelectedId(d.id);
            setDetail(d);
            return;
          }
          return;
        }
        setDetail(d);
      })
      .catch(() => {});
  }

  function ensureCapsLoaded() {
    if (caps !== null) return;
    api.getCapabilities().then((r) => setCaps(r.machines || [])).catch(() => setCaps([]));
  }

  const sessionMachineCaps = useMemo(() => {
    if (!caps || !caps.length) return null;
    const mName = activeDetail?.machine || binding?.machine || '';
    return (mName && caps.find((m) => m.name === mName)) || caps.find((m) => m.online) || caps[0] || null;
  }, [caps, activeDetail?.machine, binding?.machine]);

  function toolQuotaPct(toolName: string): number | null {
    const key = toolName === 'Claude Code' ? 'claude' : toolName === 'Codex' ? 'codex' : (toolName === 'Gemini' || toolName === 'Antigravity') ? 'gemini' : '';
    if (!key || !snapshot?.quotas) return null;
    const q = snapshot.quotas[key];
    if (!q?.windows) return null;
    const vals = Object.values(q.windows)
      .map((w) => (w && typeof w.used === 'number' ? w.used : null))
      .filter((v): v is number => v !== null);
    return vals.length ? Math.round(Math.max(...vals)) : null;
  }

  // Detecta cota esgotada no backend OU localmente pelo snapshot mais recente
  const quotaAlert = useMemo(() => {
    if (!activeDetail || activeDetail.id === dismissedQuotaFor) return null;
    if (activeDetail.quotaSuggestion && activeDetail.quotaSuggestion.suggestedTool) {
      return activeDetail.quotaSuggestion;
    }
    const curNorm = activeDetail.tool === 'Antigravity' ? 'Gemini' : activeDetail.tool;
    const curPct = toolQuotaPct(curNorm);
    if (curPct === null || curPct < 98) return null;
    const alts = ['Claude Code', 'Codex', 'Gemini', 'Ollama']
      .filter((t) => t !== curNorm)
      .map((t) => ({ tool: t, used: toolQuotaPct(t) }))
      .filter((x) => x.used === null || x.used < 95)
      .sort((a, b) => {
        const ao = a.tool === 'Ollama' ? 1 : 0;
        const bo = b.tool === 'Ollama' ? 1 : 0;
        if (ao !== bo) return ao - bo;
        return (a.used ?? 50) - (b.used ?? 50);
      });
    if (!alts.length) return null;
    return {
      reason: 'quota-full' as const,
      currentTool: curNorm,
      currentUsed: curPct,
      suggestedTool: alts[0].tool,
      suggestedUsed: alts[0].used,
      alternatives: alts,
    };
  }, [activeDetail, snapshot?.quotas, dismissedQuotaFor]);

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
    setDetail((prev) => (prev && prev.id === selectedId ? prev : null));
    stickBottomRef.current = true;
    const gen = selectionGenRef.current;
    fetchSessionDetail(selectedId, gen);
  }, [selectedId, snapshot?.version]);

  // Se a sessão recém-criada ainda não gravou o .jsonl na primeira tentativa (404), reconsulta automaticamente até aparecer
  useEffect(() => {
    if (!selectedId || activeDetail) return;
    const gen = selectionGenRef.current;
    let tries = 0;
    const timer = window.setInterval(() => {
      if (selectedIdRef.current !== selectedId || selectionGenRef.current !== gen) {
        window.clearInterval(timer);
        return;
      }
      tries += 1;
      if (tries > 15) {
        window.clearInterval(timer);
        return;
      }
      fetchSessionDetail(selectedId, gen);
      if (tries % 2 === 0) onPollNow();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [selectedId, activeDetail, onPollNow]);

  // Promove alias canônico (ex.: UUID do Codex -> rollout-...-UUID) assim que aparecer no snapshot
  useEffect(() => {
    if (!selectedId || !snapshot) return;
    const list = [...(snapshot.active || []), ...(snapshot.recent || [])];
    const match = list.find((s) => isCanonicalAlias(selectedId, s.id));
    if (match && match.id !== selectedId) {
      selectedIdRef.current = match.id;
      setSelectedId(match.id);
    }
  }, [selectedId, snapshot]);

  // Fallback: se uma nova sessão levou >8s e retornou sem UUID, abre automaticamente assim que surgir no snapshot
  useEffect(() => {
    if (!pendingLaunch) return;
    const expired = Date.now() - pendingLaunch.startedAt > 45000;
    if (expired) {
      if (onPendingLaunchConsumed) onPendingLaunchConsumed();
      return;
    }
    const list = [...(snapshot?.active || []), ...(snapshot?.recent || [])];
    const beforeSet = new Set(pendingLaunch.beforeIds);
    const folder = pendingLaunch.cwd ? pendingLaunch.cwd.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() : '';
    const normTool = pendingLaunch.tool === 'Antigravity' ? 'Gemini' : pendingLaunch.tool;
    const match = list.find((s) => {
      if (beforeSet.has(s.id)) return false;
      const st = s.tool === 'Antigravity' ? 'Gemini' : s.tool;
      if (normTool && st !== normTool) return false;
      if (pendingLaunch.machine && s.machine && s.machine !== pendingLaunch.machine) return false;
      if (folder && s.project && s.project.toLowerCase() !== folder && !s.project.toLowerCase().includes(folder)) return false;
      return true;
    });
    if (match) {
      setSelectedId(match.id);
      setViewMode('conversation');
      if (onPendingLaunchConsumed) onPendingLaunchConsumed(match.id);
      return;
    }
    const t = window.setTimeout(() => onPollNow(), 1500);
    return () => window.clearTimeout(t);
  }, [pendingLaunch, snapshot, onPendingLaunchConsumed, onPollNow]);

  const messages = useMemo<SessionHistoryMsg[]>(() => {
    if (!activeDetail) return [];
    if (activeDetail.history && activeDetail.history.length) return activeDetail.history;
    const out: SessionHistoryMsg[] = [];
    if (activeDetail.lastPrompt) out.push({ role: 'user', content: activeDetail.lastPrompt });
    if (activeDetail.lastReply) out.push({ role: 'assistant', content: activeDetail.lastReply });
    return out;
  }, [activeDetail]);

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
    if (!hasAwaitingDelivery && activeDetail?.state !== 'working') return;
    const gen = selectionGenRef.current;
    const timer = window.setInterval(() => {
      fetchSessionDetail(selectedId, gen);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [selectedId, viewMode, hasAwaitingDelivery, activeDetail?.state]);

  // Limpa anexos, cache de skills e estado de troca ao trocar de sessão
  useEffect(() => {
    setPendingImgs([]);
    setDragOver(false);
    setSkills([]);
    setPendingSwitch(null);
    setAiPickerOpen(false);
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
    if (!activeDetail || !fileList.length) return;
    const imgs = fileList.filter((f) => f && (f.type.startsWith('image/') || IMAGE_PATH_RE.test(f.name)));
    if (!imgs.length) return;
    const sessionId = activeDetail.id;
    const gen = selectionGenRef.current;
    imgs.slice(0, 8).forEach((file, idx) => {
      const attId = `att-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
      const fallbackName = file.name && file.name !== 'image.png'
        ? file.name
        : `colada-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      const rd = new FileReader();
      rd.onload = async () => {
        if (selectedIdRef.current !== sessionId || selectionGenRef.current !== gen) return;
        const dataUrl = String(rd.result || '');
        setPendingImgs((prev) => [...prev, { id: attId, name: fallbackName, previewUrl: dataUrl, uploading: true }]);
        try {
          const r = await api.uploadAttachment({
            id: sessionId,
            fileName: fallbackName,
            base64Data: dataUrl,
          });
          if (selectedIdRef.current !== sessionId || selectionGenRef.current !== gen) return;
          setPendingImgs((prev) =>
            prev.map((item) => (item.id === attId ? { ...item, name: r.name, path: r.path, uploading: false } : item)),
          );
        } catch (err) {
          if (selectedIdRef.current !== sessionId || selectionGenRef.current !== gen) return;
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
    if (!activeDetail || activeDetail.id !== entry.sessionId) return;
    const gen = selectionGenRef.current;
    const targetKey = activeDetail.key || '';
    const targetTool = activeDetail.tool;
    setSending(true);
    stickBottomRef.current = true;
    try {
      await api.replySession({ id: entry.sessionId, key: targetKey, tool: targetTool, text: entry.promptSent });
      if (pendingCardExec && onCardExecAttached) {
        onCardExecAttached(entry.sessionId);
      }
      setOutgoing((prev) =>
        prev.map((m) => (m.localId === entry.localId ? { ...m, status: 'sent', error: undefined } : m)),
      );
      onPollNow();
      fetchSessionDetail(entry.sessionId, gen);
      window.setTimeout(() => {
        fetchSessionDetail(entry.sessionId, gen);
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

  async function executeTransparentSwitch({
    targetTool,
    targetModel = '',
    note = '',
  }: {
    targetTool: string;
    targetModel?: string;
    note?: string;
  }) {
    if (!activeDetail || sending) return;
    const targetId = activeDetail.id;
    setSending(true);
    stickBottomRef.current = true;
    try {
      const r = await api.handoff({
        id: targetId,
        targetTool,
        targetModel: targetModel || undefined,
        note: note || undefined,
        cardTitle: pendingCardExec?.title || undefined,
      });
      setHandoffOpen(false);
      setHandoffNote('');
      setPendingSwitch(null);
      setAiPickerOpen(false);
      const nextId = r.id || '';
      if (nextId && pendingCardExec && onCardExecAttached) {
        onCardExecAttached(nextId);
      }
      onNotify(`${r.tool} assumiu a conversa!`);
      onPollNow();
      if (nextId) {
        // Transição suave na mesma janela: preserva o histórico atual enquanto o novo driver carrega
        setDetail((prev) => (prev ? { ...prev, id: nextId, tool: r.tool, state: 'working' } : prev));
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
        const gen = selectionGenRef.current;
        window.setTimeout(() => fetchSessionDetail(nextId, gen), 600);
      }
    } catch (e) {
      onNotify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  async function sendReply() {
    if (!activeDetail || sending || uploadingImgs) return;
    const cleanText = replyText.trim();
    if (!cleanText) return;
    const imgLines = readyImgs.map((img) => `[Imagem anexada: ${img.path}]`);
    const promptSent = [...imgLines, cleanText].join('\n');

    // Troca transparente (lazy switch): o usuário trocou a IA no seletor do input e enviou a mensagem
    if (pendingSwitch && pendingSwitch.tool && pendingSwitch.tool !== activeDetail.tool) {
      setReplyText('');
      setPendingImgs([]);
      await executeTransparentSwitch({
        targetTool: pendingSwitch.tool,
        targetModel: pendingSwitch.model,
        note: promptSent,
      });
      return;
    }

    const entry: OutgoingMsg = {
      localId: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: activeDetail.id,
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
    if (!activeDetail || activeDetail.id !== entry.sessionId) return;
    setOutgoing((prev) =>
      prev.map((m) => (m.localId === entry.localId ? { ...m, status: 'sending', error: undefined, sentAt: Date.now() } : m)),
    );
    await dispatchOutgoing(entry);
  }

  async function doHandoff() {
    await executeTransparentSwitch({
      targetTool: handoffTool,
      targetModel: handoffModel,
      note: handoffNote,
    });
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
                  {s.handoffChain && s.handoffChain.length > 1 && (
                    <span className="badge" style={{ fontSize: 10, padding: '1px 5px' }} title={`Conversa contínua: ${s.handoffChain.join(' → ')}`}>
                      {s.handoffChain.map((t) => (t === 'Claude Code' ? 'Claude' : t)).join(' → ')}
                    </span>
                  )}
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
      ) : !activeDetail ? (
        <div className="empty">Carregando sessão…</div>
      ) : (
        <div className="hud-chat-wrap">
          {/* Action / metadata sub-bar */}
          <div className="hud-chat-bar">
            <span className={`badge ${activeDetail.state}`}>{activeDetail.state}</span>
            <span className="badge" style={{ gap: 5 }}><ToolIcon tool={activeDetail.tool} size={11} /> {activeDetail.tool}</span>
            {activeDetail.handoffChain && activeDetail.handoffChain.length > 1 && (
              <span className="badge" style={{ fontSize: 10 }} title={`Histórico unificado: ${activeDetail.handoffChain.join(' → ')}`}>
                {activeDetail.handoffChain.map((t) => (t === 'Claude Code' ? 'Claude' : t)).join(' → ')}
              </span>
            )}
            {activeDetail.machine && <span className="badge">{activeDetail.machine}</span>}
            {!!activeDetail.contextWindow && activeDetail.contextWindow > 0 && (
              <span className="badge">ctx {Math.round(((activeDetail.context || 0) / activeDetail.contextWindow) * 100)}%</span>
            )}
            <div style={{ flex: 1 }} />
            {activeDetail.canStop && (
              <button
                className="btn btn-sm btn-danger"
                onClick={async () => {
                  const targetId = activeDetail.id;
                  if (selectedIdRef.current !== targetId) return;
                  try { const r = await api.stopTurn(targetId); onNotify(r.message, !r.ok); onPollNow(); }
                  catch (e) { onNotify((e as Error).message, true); }
                }}
              >
                <Square size={11} /> Parar
              </button>
            )}
            <button
              className="btn btn-sm btn-icon"
              title={activeDetail.pinned ? 'Desfixar sessão' : 'Fixar sessão no topo'}
              onClick={async () => {
                const targetId = activeDetail.id;
                if (selectedIdRef.current !== targetId) return;
                try {
                  const next = !activeDetail.pinned;
                  await api.setSessionMeta({ id: targetId, pinned: next });
                  setDetail((cur) => (cur && cur.id === targetId ? { ...cur, pinned: next } : cur));
                  onPollNow();
                  onNotify(next ? 'Sessão fixada.' : 'Sessão desfixada.');
                } catch (e) { onNotify((e as Error).message, true); }
              }}
            >
              <Star size={12} fill={activeDetail.pinned ? '#e5c063' : 'none'} color={activeDetail.pinned ? '#e5c063' : 'currentColor'} />
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                if (!handoffOpen) {
                  ensureCapsLoaded();
                  const cur = activeDetail.tool === 'Antigravity' ? 'Gemini' : activeDetail.tool;
                  const next = quotaAlert?.suggestedTool || (cur === 'Gemini' ? 'Codex' : cur === 'Codex' ? 'Claude Code' : 'Codex');
                  setHandoffTool(next);
                  setHandoffModel('');
                }
                setHandoffOpen(!handoffOpen);
              }}
              title="Trocar IA mantendo a mesma conversa contínua (ex.: Gemini → Codex)"
            >
              <GitFork size={12} /> Trocar IA
            </button>
            {activeDetail.lastReply && (
              <button
                className="btn btn-sm btn-icon"
                title="Ouvir última resposta (TTS local)"
                onClick={async () => {
                  try {
                    const r = await api.speakText(activeDetail.lastReply || '');
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
          {handoffOpen && (() => {
            const targetModels = sessionMachineCaps?.tools?.[handoffTool]?.models || [];
            return (
              <div style={{ padding: 10, borderBottom: '1px solid var(--border)', background: '#161a22' }}>
                <div style={{ fontSize: 11.5, color: 'var(--ds-muted)', marginBottom: 8, lineHeight: 1.45 }}>
                  Mantém esta mesma conversa na tela, salva o resumo de contexto e troca a IA que responde a partir do ponto de parada.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
                    <label>Nova IA</label>
                    <select className="sel" value={handoffTool} onChange={(e) => { setHandoffTool(e.target.value); setHandoffModel(''); }}>
                      {['Claude Code', 'Codex', 'Gemini', 'Ollama'].map((t) => {
                        const pct = toolQuotaPct(t);
                        return <option key={t} value={t}>{t}{pct !== null ? ` (${pct}%)` : ''}</option>;
                      })}
                    </select>
                  </div>
                  {targetModels.length > 0 && (
                    <div className="field" style={{ flex: 1, minWidth: 150, marginBottom: 0 }}>
                      <label>Modelo (opcional)</label>
                      <select className="sel" value={handoffModel} onChange={(e) => setHandoffModel(e.target.value)}>
                        <option value="">Padrão da CLI</option>
                        {targetModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <textarea className="ta" rows={2} value={handoffNote} onChange={(e) => setHandoffNote(e.target.value)} placeholder="Instrução opcional (vazio = continuar exatamente de onde parou)…" />
                <div className="card-actions">
                  <button className="btn btn-sm btn-primary" disabled={sending} onClick={doHandoff}>Assumir agora com {handoffTool}</button>
                  <button
                    className="btn btn-sm"
                    disabled={sending}
                    onClick={() => {
                      setPendingSwitch({ tool: handoffTool, model: handoffModel });
                      setHandoffOpen(false);
                    }}
                    title="Não gasta turno extra: a troca acontece quando você enviar a próxima mensagem"
                  >
                    Trocar na próxima msg
                  </button>
                  <button className="btn btn-sm" onClick={() => setHandoffOpen(false)}>Cancelar</button>
                </div>
              </div>
            );
          })()}

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
                {activeDetail.permission && (
                  <div className="conflict-box" style={{ marginBottom: 10 }}>
                    <h4 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <ShieldAlert size={14} /> Permissão · {activeDetail.permission.tool}
                    </h4>
                    {activeDetail.permission.summary && (
                      <pre className="mono" style={{ fontSize: 11.5, margin: '6px 0 8px', whiteSpace: 'pre-wrap' }}>
                        {activeDetail.permission.summary}
                      </pre>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={async () => {
                          const targetId = activeDetail.id;
                          const permId = activeDetail.permission?.id;
                          if (!permId || selectedIdRef.current !== targetId) return;
                          try {
                            await api.decidePermission({ id: permId, decision: 'allow', session: targetId });
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
                          const targetId = activeDetail.id;
                          const permId = activeDetail.permission?.id;
                          if (!permId || selectedIdRef.current !== targetId) return;
                          try {
                            await api.decidePermission({ id: permId, decision: 'deny', session: targetId });
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
                        if (m.role === 'handoff') {
                          return (
                            <div key={`ho-${i}`} className="handoff-divider" role="separator">
                              <span className="handoff-divider-pill">
                                <GitFork size={11} />
                                <span>{m.toTool || 'Outra IA'} assumiu a conversa</span>
                                {m.fromTool && <span style={{ opacity: 0.7 }}>({m.fromTool} → {m.toTool})</span>}
                                {m.at ? <span style={{ opacity: 0.65 }}>· {fmtMsgTime(m.at)}</span> : null}
                              </span>
                            </div>
                          );
                        }
                        const userParsed = m.role === 'user' ? parseAttachedImages(m.content) : null;
                        const multiAi = !!(activeDetail.sharedSession && activeDetail.sharedSession.tools.length > 1);
                        const prevAssistantTool = (() => {
                          for (let k = i - 1; k >= 0; k--) {
                            if (messages[k].role === 'assistant') return messages[k].tool || '';
                            if (messages[k].role === 'handoff') return '';
                          }
                          return '';
                        })();
                        const showAiTag = multiAi && m.role === 'assistant' && m.tool && m.tool !== prevAssistantTool;
                        return (
                          <div key={i} className={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>
                            {showAiTag && m.tool && (
                              <div className="msg-ai-tag">
                                <ToolIcon tool={m.tool} size={11} /> {m.tool}
                              </div>
                            )}
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
                                      const imgSrc = api.sessionImageUrl(activeDetail.id, imgPath, false);
                                      const dlSrc = api.sessionImageUrl(activeDetail.id, imgPath, true);
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
                                        const resolvedSrc = isLocal ? api.sessionImageUrl(activeDetail.id, raw, false) : raw;
                                        const dlSrc = isLocal ? api.sessionImageUrl(activeDetail.id, raw, true) : raw;
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
                                          const imgSrc = api.sessionImageUrl(activeDetail.id, raw, false);
                                          const dlSrc = api.sessionImageUrl(activeDetail.id, raw, true);
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
                  {(activeDetail.state === 'working' || hasAwaitingDelivery) && (
                    <div className="msg ai msg-typing">
                      <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
                      <span>
                        {activeDetail.state === 'working'
                          ? (activeDetail.lastTool ? `executando ${activeDetail.lastTool}…` : 'pensando…')
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
                {quotaAlert && !pendingSwitch && (
                  <div className="quota-switch-bar">
                    <span className="ell" style={{ flex: 1 }}>
                      ⚠️ Cota de <b>{quotaAlert.currentTool}</b>{quotaAlert.currentUsed !== null ? ` (${quotaAlert.currentUsed}%)` : ' atingiu o limite'}
                      {' · '}<b>{quotaAlert.suggestedTool}</b>{quotaAlert.suggestedUsed !== null ? ` (${quotaAlert.suggestedUsed}%)` : ''} livre
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      disabled={sending}
                      onClick={() => executeTransparentSwitch({ targetTool: quotaAlert.suggestedTool })}
                    >
                      Assumir agora
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '2px 7px', fontSize: 11 }}
                      disabled={sending}
                      onClick={() => setPendingSwitch({ tool: quotaAlert.suggestedTool, model: '' })}
                    >
                      Próx. msg
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      style={{ padding: 2, border: 0, background: 'transparent' }}
                      title="Dispensar aviso"
                      onClick={() => setDismissedQuotaFor(activeDetail.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
                {pendingSwitch && (
                  <div className="lazy-switch-bar">
                    <GitFork size={12} color="var(--accent)" />
                    <span className="ell" style={{ flex: 1 }}>
                      Próxima mensagem assumida por <b>{pendingSwitch.tool}</b>
                      {pendingSwitch.model ? <span className="mono" style={{ opacity: 0.8 }}> ({pendingSwitch.model})</span> : null}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '2px 7px', fontSize: 11 }}
                      disabled={sending}
                      onClick={() => executeTransparentSwitch({ targetTool: pendingSwitch.tool, targetModel: pendingSwitch.model })}
                      title="Retomar imediatamente do ponto de parada sem escrever nova mensagem"
                    >
                      Continuar agora
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      style={{ padding: 2, border: 0, background: 'transparent' }}
                      title="Cancelar troca de IA"
                      onClick={() => setPendingSwitch(null)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
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
                {replyText.startsWith('/') && skills.length > 0 && (
                  <div className="chat-slash-pop">
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

                <div className="chat-composer">
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
                  <textarea
                    className="chat-composer-ta"
                    rows={1}
                    value={replyText}
                    onChange={(e) => {
                      const v = e.target.value;
                      setReplyText(v);
                      e.target.style.height = 'auto';
                      e.target.style.height = `${Math.min(180, Math.max(36, e.target.scrollHeight))}px`;
                      if (v.startsWith('/') && !skills.length) {
                        api.getSkills(activeDetail.cwd || '', activeDetail.machine || '', activeDetail.tool || '')
                          .then((r) => setSkills(r.skills || []))
                          .catch(() => {});
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
                    placeholder="Responder… (Enter envia · Ctrl+V cola imagem · / skills)"
                  />
                  <div className="chat-composer-bar">
                    <div className="chat-composer-tools" style={{ position: 'relative' }}>
                      <button
                        type="button"
                        className={`chat-ai-pill ${pendingSwitch ? 'switching' : ''}`}
                        onClick={() => {
                          ensureCapsLoaded();
                          setAiPickerOpen((v) => !v);
                        }}
                        title="Trocar IA nesta mesma conversa (próxima mensagem ou imediato)"
                      >
                        <ToolIcon tool={pendingSwitch?.tool || activeDetail.tool} size={12} />
                        <span>{(pendingSwitch?.tool || activeDetail.tool) === 'Claude Code' ? 'Claude' : (pendingSwitch?.tool || activeDetail.tool)}</span>
                        <ChevronDown size={11} />
                      </button>
                      {aiPickerOpen && (() => {
                        const selectedTool = pendingSwitch?.tool || activeDetail.tool;
                        const selModels = sessionMachineCaps?.tools?.[selectedTool]?.models || [];
                        return (
                          <div className="chat-ai-popover">
                            <div className="chat-ai-pop-head">Trocar IA nesta conversa</div>
                            {['Claude Code', 'Codex', 'Gemini', 'Ollama'].map((t) => {
                              const pct = toolQuotaPct(t);
                              const isCur = activeDetail.tool === t;
                              const isPicked = selectedTool === t;
                              const avail = !sessionMachineCaps || !!sessionMachineCaps.tools?.[t];
                              return (
                                <button
                                  key={t}
                                  type="button"
                                  className={`chat-ai-opt ${isPicked ? 'active' : ''}`}
                                  disabled={!avail}
                                  onClick={() => {
                                    if (isCur) {
                                      setPendingSwitch(null);
                                      setAiPickerOpen(false);
                                    } else {
                                      setPendingSwitch({ tool: t, model: '' });
                                    }
                                  }}
                                >
                                  <ToolIcon tool={t} size={12} />
                                  <span style={{ flex: 1, textAlign: 'left' }}>
                                    {t}{isCur ? ' (atual)' : ''}
                                  </span>
                                  {pct !== null && (
                                    <span className={`badge ${pct >= 98 ? 'perm' : ''}`} style={{ fontSize: 10, padding: '1px 5px' }}>
                                      {pct}%
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                            {pendingSwitch && selModels.length > 0 && (
                              <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border)' }}>
                                <select
                                  className="sel"
                                  style={{ fontSize: 11.5, padding: '4px 6px' }}
                                  value={pendingSwitch.model}
                                  onChange={(e) => setPendingSwitch({ ...pendingSwitch, model: e.target.value })}
                                >
                                  <option value="">Modelo padrão ({pendingSwitch.tool})</option>
                                  {selModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                                </select>
                              </div>
                            )}
                            {pendingSwitch && (
                              <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderTop: '1px solid var(--border)' }}>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-primary"
                                  style={{ flex: 1, fontSize: 11 }}
                                  disabled={sending}
                                  onClick={() => executeTransparentSwitch({ targetTool: pendingSwitch.tool, targetModel: pendingSwitch.model })}
                                >
                                  Continuar agora
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  style={{ fontSize: 11 }}
                                  onClick={() => setAiPickerOpen(false)}
                                >
                                  Próx. msg
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <label className="chat-tool-btn" title="Anexar ou colar imagem (Ctrl+V)">
                        <Paperclip size={15} />
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
                        type="button"
                        className="chat-tool-btn"
                        title="Comandos e skills (/)"
                        onClick={() => {
                          if (!replyText.startsWith('/')) setReplyText('/');
                          if (!skills.length) {
                            api.getSkills(activeDetail.cwd || '', activeDetail.machine || '', activeDetail.tool || '')
                              .then((r) => setSkills(r.skills || []))
                              .catch(() => {});
                          }
                        }}
                      >
                        <Slash size={14} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="chat-send-btn"
                      disabled={sending || uploadingImgs || !replyText.trim()}
                      onClick={sendReply}
                      title={uploadingImgs ? 'Aguarde o envio da imagem…' : !replyText.trim() ? 'Escreva uma mensagem para enviar' : 'Enviar resposta (Enter)'}
                      aria-label="Enviar resposta"
                    >
                      <ArrowUp size={16} strokeWidth={2.4} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* MODE 2: TERMINAL INTERATIVO REAL (xterm.js + Win32 ConPTY / Unix PTY estilo Mr. Mak) */
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', background: '#101217', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <div className="seg">
                  <button className={ptySubMode === 'resume' ? 'on' : ''} onClick={() => setPtySubMode('resume')}>
                    CLI {activeDetail.tool}
                  </button>
                  <button className={ptySubMode === 'shell' ? 'on' : ''} onClick={() => setPtySubMode('shell')}>
                    Shell
                  </button>
                </div>
                <span className="mono ell" style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>
                  {activeDetail.cwd || binding?.cwd || '(sem cwd)'}
                </span>
              </div>
              {activeDetail.cwd || binding?.cwd ? (
                <Suspense fallback={<div className="empty">Carregando terminal PTY…</div>}>
                  <XtermPty
                    ptyKey={`sess:${activeDetail.id}:${ptySubMode}`}
                    cwd={activeDetail.cwd || binding?.cwd || ''}
                    machine={activeDetail.machine || binding?.machine}
                    mode={ptySubMode}
                    tool={activeDetail.tool}
                    sessionId={activeDetail.id}
                    model={activeDetail.models?.[0] || ''}
                    minHeight={260}
                  />
                </Suspense>
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

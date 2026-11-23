import type {
  CardDoc,
  ConflictError,
  FsEntry,
  GitInfo,
  MachineCaps,
  MemoryData,
  SessionDetail,
  Snapshot,
  WorkspaceEntity,
  WorkspaceIndex,
} from './types';

function authToken(): string {
  const sp = new URLSearchParams(window.location.search);
  return sp.get('t') || '';
}

export function withToken(url: string): string {
  const t = authToken();
  if (!t) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;
}

async function apiFetch<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(withToken(url), {
    credentials: 'same-origin',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
    ...opts,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 409 && json && 'currentHash' in json) {
    const err = new Error(String(json.error || 'Conflito de versão (409).')) as ConflictError;
    err.status = 409;
    err.conflict = true;
    err.currentContent = json.currentContent;
    err.currentHash = String(json.currentHash || '');
    throw err;
  }
  if (!res.ok) {
    const msg = (json && typeof json.error === 'string' ? json.error : text) || `HTTP ${res.status}`;
    throw new Error(msg.slice(0, 300));
  }
  return (json as T) ?? (text as unknown as T);
}

export const api = {
  getSnapshot: (version?: string) =>
    apiFetch<Snapshot>(version ? `/api/snapshot?desde=${encodeURIComponent(version)}&espera=25` : '/api/snapshot'),

  getSession: (id: string) =>
    apiFetch<SessionDetail>(`/api/session?id=${encodeURIComponent(id)}`),

  getCapabilities: () =>
    apiFetch<{ machines: MachineCaps[] }>('/api/capabilities'),

  newSession: (body: { machine?: string; tool: string; model?: string; cwd?: string; prompt: string }) =>
    apiFetch<{ ok: boolean; id?: string; tool: string; machine?: string }>('/api/new', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  replySession: (body: { id: string; key: string; tool: string; text: string }) =>
    apiFetch<{ sent?: boolean; queued?: string | null; listening?: number | null }>('/api/reply', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  stopTurn: (id: string) =>
    apiFetch<{ ok: boolean; message: string }>('/api/stop', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  handoff: (body: { id: string; targetTool: string; note?: string }) =>
    apiFetch<{ ok: boolean; id?: string; tool: string; machine?: string; handoffFile?: string }>('/api/handoff', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getWorkspaceIndex: () =>
    apiFetch<WorkspaceIndex>('/api/workspace/index'),

  createEntity: (body: {
    title: string;
    description?: string;
    category?: string;
    template?: string;
    projectBindings?: { machine: string; cwd: string }[];
    defaultAgent?: string;
  }) =>
    apiFetch<{ ok: boolean; entity: WorkspaceEntity }>('/api/workspace/entity', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getEntityFile: <T = CardDoc | string>(id: string, path: string) =>
    apiFetch<{ ok: boolean; entityId: string; path: string; viewer: string; content: T; raw: string; hash: string }>(
      `/api/workspace/entity/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`,
    ),

  saveEntityFile: (body: { id: string; path: string; content: CardDoc | string; baseHash?: string }) =>
    apiFetch<{ ok: boolean; hash: string }>('/api/workspace/entity/file', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  uploadEntityMedia: (body: { id: string; fileName: string; base64Data: string }) =>
    apiFetch<{ ok: boolean; path: string; size: number }>('/api/workspace/entity/media', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  entityAssetUrl: (id: string, relPath: string) =>
    withToken(`/api/workspace/entity/asset?id=${encodeURIComponent(id)}&path=${encodeURIComponent(relPath)}`),

  getGlobalDoc: (area: string, name: string) =>
    apiFetch<{ ok: boolean; area: string; name: string; content: string; hash: string }>(
      `/api/workspace/doc?area=${encodeURIComponent(area)}&name=${encodeURIComponent(name)}`,
    ),

  saveGlobalDoc: (body: { area: string; name: string; content: string; baseHash?: string }) =>
    apiFetch<{ ok: boolean; hash: string }>('/api/workspace/doc', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  getMemory: (project: string, cwd?: string) =>
    apiFetch<MemoryData>(
      `/api/memory?project=${encodeURIComponent(project)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),

  saveMemoryFile: (body: { project: string; cwd?: string; mode?: string; file: string; content: string; baseHash?: string }) =>
    apiFetch<{ ok: boolean; file: string; hash: string }>('/api/memory/file', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  runDream: (body: { project: string; cwd?: string; force?: boolean; ignoreQuota?: boolean }) =>
    apiFetch<{ ok: boolean; skipped?: boolean; reason?: string; summary?: string; engine?: string; sessionsProcessed?: number }>(
      '/api/memory/dream',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  undoDream: (body: { project: string; cwd?: string }) =>
    apiFetch<{ ok: boolean; backup: string; restored: number }>('/api/memory/undo', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  installBridges: (body: { project: string; cwd: string; mode?: string }) =>
    apiFetch<{ ok: boolean; updated: string[]; memoryDir: string }>('/api/memory/bridges', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listFiles: (cwd: string, relDir = '', machine = '') =>
    apiFetch<{ ok: boolean; dir: string; entries: FsEntry[]; truncated: boolean }>(
      `/api/fs/list?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relDir)}${machine ? `&machine=${encodeURIComponent(machine)}` : ''}`,
    ),

  getGit: (cwd: string, machine = '') =>
    apiFetch<GitInfo>(
      `/api/fs/git?cwd=${encodeURIComponent(cwd)}${machine ? `&machine=${encodeURIComponent(machine)}` : ''}`,
    ),

  previewFile: (opts: { cwd: string; path: string; mode: 'diff' | 'content'; machine?: string }) =>
    apiFetch<{ ok: boolean; path: string; mode: string; content: string; truncated?: boolean; binary?: boolean; redacted?: boolean; fallback?: string }>(
      `/api/fs/preview?cwd=${encodeURIComponent(opts.cwd)}&path=${encodeURIComponent(opts.path)}&mode=${opts.mode}${opts.machine ? `&machine=${encodeURIComponent(opts.machine)}` : ''}`,
    ),
};

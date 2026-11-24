import type {
  CardDoc,
  CardItem,
  ConflictError,
  DreamUsage,
  FsEntry,
  GitInfo,
  GoldfishEstimate,
  GoldfishReviewResult,
  MachineCaps,
  MemoryData,
  ProjectDocEntry,
  SessionDetail,
  Snapshot,
  UsageAggregate,
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

  refreshQuotas: () =>
    apiFetch<Snapshot>('/api/refresh', { method: 'POST', body: '{}' }),

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

  setSessionMeta: (body: { id: string; pinned?: boolean; alias?: string; group?: string }) =>
    apiFetch<{ ok: boolean; id: string; meta: { pinned?: boolean; alias?: string; group?: string } }>('/api/session-meta', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  uploadAttachment: (body: { id?: string; fileName: string; base64Data: string }) =>
    apiFetch<{ ok: boolean; path: string; relPath: string; name: string; size: number }>('/api/upload', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getSkills: (cwd = '') =>
    apiFetch<{ skills: { cmd: string; name: string; description: string; prompt?: string; source: string }[] }>(
      `/api/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`,
    ),

  speakText: (text: string) =>
    apiFetch<{ ok: boolean; contentType: string; engine: string; audioBase64: string }>('/api/voice/speak?format=json', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  execTerminal: (body: { cwd: string; machine?: string; command: string; timeoutMs?: number }) =>
    apiFetch<{
      ok: boolean;
      code: number;
      timedOut: boolean;
      truncated: boolean;
      redacted: boolean;
      durationMs: number;
      cwd: string;
      stdout: string;
      stderr: string;
    }>('/api/fs/exec', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getWorkspaceIndex: () =>
    apiFetch<WorkspaceIndex>('/api/workspace/index'),

  getWorkspaceSync: () =>
    apiFetch<import('./types').WorkspaceSyncStatus>('/api/workspace/sync'),

  runWorkspaceSync: (body: { init?: boolean; remote?: string; message?: string } = {}) =>
    apiFetch<{ ok: boolean; committed?: boolean; pulled?: boolean; pushed?: boolean; status: import('./types').WorkspaceSyncStatus }>('/api/workspace/sync', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createEntity: (body: {
    title: string;
    description?: string;
    group?: string;
    category?: string;
    template?: string;
    projectBindings?: { machine: string; cwd: string }[];
    defaultAgent?: string;
  }) =>
    apiFetch<{ ok: boolean; entity: WorkspaceEntity }>('/api/workspace/entity', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateEntity: (body: {
    id: string;
    title?: string;
    description?: string;
    group?: string;
    pinned?: boolean;
    projectBindings?: { machine: string; cwd: string }[];
  }) =>
    apiFetch<{ ok: boolean; entity: WorkspaceEntity; groups: string[] }>('/api/workspace/entity', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  deleteEntity: (id: string) =>
    apiFetch<{ ok: boolean; id: string }>('/api/workspace/entity/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  saveGroup: (body: { name: string; renameFrom?: string; remove?: boolean; machine?: string; rootCwd?: string }) =>
    apiFetch<{ ok: boolean; groups: string[]; groupMeta?: Record<string, { machine?: string; rootCwd?: string }> }>('/api/workspace/group', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reorderWorkspace: (body: {
    groups?: string[];
    entityIds?: string[];
    moveEntity?: { id: string; group?: string };
  }) =>
    apiFetch<{ ok: boolean; groups: string[]; entities: WorkspaceEntity[] }>('/api/workspace/reorder', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  pinProject: (body: { machine?: string; cwd: string; pinned: boolean }) =>
    apiFetch<{ ok: boolean; pinned: string[] }>('/api/projects/pin', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  pickFolder: (body: { machine?: string; initialDir?: string } = {}) =>
    apiFetch<{ ok: boolean; path: string; canceled: boolean }>('/api/fs/pick-folder', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  decidePermission: (body: { id: string; decision: 'allow' | 'deny'; session: string }) =>
    apiFetch<{ ok?: boolean }>('/api/permission', {
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

  listMemorySummary: () =>
    apiFetch<{
      projects: { project: string; slug: string; pendingCount: number; lastDreamAt?: number }[];
      schedule?: { enabled?: boolean; hour?: number; workspaceOnly?: boolean };
      usage?: UsageAggregate;
    }>('/api/memory'),

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
    apiFetch<{
      ok: boolean;
      skipped?: boolean;
      reason?: string;
      summary?: string;
      engine?: string;
      sessionsProcessed?: number;
      durationMs?: number;
      usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; totalTokens: number; estimated?: boolean; costUsd?: number | null };
    }>(
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

  commitGit: (body: { cwd: string; machine?: string; message: string; push?: boolean }) =>
    apiFetch<{
      ok: boolean;
      committed: boolean;
      nothingToCommit?: boolean;
      branch?: string;
      hash?: string;
      message?: string;
      pushed?: boolean;
      pushError?: string;
    }>('/api/fs/git-commit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  previewFile: (opts: { cwd: string; path: string; mode: 'diff' | 'content'; machine?: string }) =>
    apiFetch<{ ok: boolean; path: string; mode: string; content: string; truncated?: boolean; binary?: boolean; redacted?: boolean; fallback?: string }>(
      `/api/fs/preview?cwd=${encodeURIComponent(opts.cwd)}&path=${encodeURIComponent(opts.path)}&mode=${opts.mode}${opts.machine ? `&machine=${encodeURIComponent(opts.machine)}` : ''}`,
    ),

  sessionImageUrl: (sessionId: string, imgPath: string, download = false) =>
    withToken(`/api/fs/image?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(imgPath)}${download ? '&download=1' : ''}`),

  // ---- Docs & Specs reais do projeto + Quadro portátil (.ai-workspace/) + EGM Lite ----

  listProjectDocs: (entityId: string) =>
    apiFetch<{ ok: boolean; cwd: string; hasPortableBoard: boolean; boardPath: string; gitMode: string; docs: ProjectDocEntry[] }>(
      `/api/workspace/project/docs?entityId=${encodeURIComponent(entityId)}`,
    ),

  getProjectDoc: (entityId: string, docPath: string) =>
    apiFetch<{ ok: boolean; path: string; category: string; title: string; content: string; hash: string; mtimeMs: number; size: number }>(
      `/api/workspace/project/doc?entityId=${encodeURIComponent(entityId)}&path=${encodeURIComponent(docPath)}`,
    ),

  saveProjectDoc: (body: { entityId: string; path: string; content: string; baseHash?: string }) =>
    apiFetch<{ ok: boolean; path: string; hash: string }>('/api/workspace/project/doc', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  createProjectSpec: (body: { entityId: string; title: string; summary?: string; folder?: string }) =>
    apiFetch<{ ok: boolean; path: string; title: string; content: string; hash: string }>('/api/workspace/project/spec', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getProjectBoard: (entityId: string) =>
    apiFetch<{
      ok: boolean;
      exists: boolean;
      migrated?: boolean;
      storage: 'in-project' | 'hub' | 'hub-cache';
      offlineFallback?: boolean;
      path?: string;
      content: CardDoc | null;
      hash: string;
    }>(`/api/workspace/project/board?entityId=${encodeURIComponent(entityId)}`),

  saveProjectBoard: (body: { entityId: string; content: CardDoc; baseHash?: string }) =>
    apiFetch<{ ok: boolean; storage: string; path?: string; hash: string }>('/api/workspace/project/board', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  importProjectDocs: (body: { entityId: string; paths?: string[]; dryRun?: boolean }) =>
    apiFetch<{
      ok: boolean;
      dryRun?: boolean;
      tokensUsed: number;
      docsScanned: { path: string; title: string; category: string; count: number }[];
      totalDetected?: number;
      toAdd?: CardItem[];
      alreadyPresent?: number;
      addedCount?: number;
      totalItems?: number;
      board?: CardDoc;
      hash?: string;
    }>('/api/workspace/project/import-docs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reviewProjectSpec: (body: { entityId: string; docPath: string; itemId?: string; engine?: string; model?: string; dryRun?: boolean }) =>
    apiFetch<GoldfishEstimate | GoldfishReviewResult>('/api/workspace/project/review', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  structureDocsAi: (body: { entityId: string; docPaths: string[]; engine?: string; model?: string; dryRun?: boolean }) =>
    apiFetch<{
      ok: boolean;
      dryRun?: boolean;
      available?: boolean;
      engine?: string;
      model?: string;
      reason?: string;
      estimatedInputTokens?: number;
      estimatedOutputTokens?: number;
      estimatedTotalTokens?: number;
      durationMs?: number;
      usage?: DreamUsage;
      items?: CardItem[];
    }>('/api/workspace/project/structure-ai', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  syncDocCheckbox: (body: { entityId: string; docRef: string; title?: string; done: boolean }) =>
    apiFetch<{ ok: boolean; matched: boolean; changed: boolean; path?: string; lineNo?: number; done?: boolean }>(
      '/api/workspace/project/sync-checkbox',
      { method: 'POST', body: JSON.stringify(body) },
    ),

  undoProjectBoard: (entityId: string) =>
    apiFetch<{ ok: boolean; restoredBackup: string; remainingBackups: number; board: CardDoc; hash: string }>(
      '/api/workspace/project/board-undo',
      { method: 'POST', body: JSON.stringify({ entityId }) },
    ),

  getWorkflowUsage: () =>
    apiFetch<UsageAggregate>('/api/workspace/usage'),
};

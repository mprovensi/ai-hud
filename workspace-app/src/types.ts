export type CardTemplate = 'board' | 'research' | 'gallery';
export type CardStatus = 'idea' | 'in-progress' | 'review' | 'done';

export interface CardItem {
  id: string;
  title: string;
  body?: string;
  image?: string;
  alt?: string;
  prompt?: string;
  url?: string;
  linkLabel?: string;
  status?: CardStatus | '';
  sessionRef?: { machine?: string; id: string; tool?: string } | null;
  handoffPath?: string;
}

export interface CardDoc {
  format: 'ai-card';
  version: 1;
  template: CardTemplate;
  title: string;
  summary?: string;
  items: CardItem[];
}

export interface EntityStep {
  name: string;
  path: string;
  viewer?: 'card' | 'markdown' | 'html';
}

export interface ProjectBinding {
  machine: string;
  cwd: string;
}

export interface WorkspaceEntity {
  id: string;
  title: string;
  description?: string;
  category?: string;
  status?: string;
  pinned?: boolean;
  folder: string;
  projectBindings?: ProjectBinding[];
  defaultAgent?: string;
  steps: EntityStep[];
  created?: string;
  updated?: string;
}

export interface GlobalDocItem {
  name: string;
  mtimeMs: number;
  size: number;
}

export interface WorkspaceIndex {
  root: string;
  format: string;
  version: number;
  entities: WorkspaceEntity[];
  context: GlobalDocItem[];
  knowledge: GlobalDocItem[];
  skills: GlobalDocItem[];
  handoffs: GlobalDocItem[];
}

export interface MemoryData {
  project: string;
  slug: string;
  cwd: string;
  mode: 'in-repo' | 'workspace-hub';
  dir: string;
  hasMemory: boolean;
  files: Record<string, string>;
  hashes: Record<string, string>;
  episodic: string[];
  lastDreamAt: number;
  lastEngine: string;
  lastSummary: string;
  pendingCount: number;
  pendingIds: string[];
}

export interface QuotaWindow {
  used: number;
  resetsAt?: number;
}

export interface QuotaTool {
  plan?: string;
  windows?: Record<string, QuotaWindow>;
}

export interface SessionCard {
  id: string;
  tool: string;
  project: string;
  title?: string;
  state: 'working' | 'waiting' | 'idle' | 'closed' | 'permission';
  lastTool?: string;
  start: number;
  end: number;
  tokens?: number;
  prompts?: number;
  lastPrompt?: string;
  lastReply?: string;
  context?: number;
  contextWindow?: number;
  key?: string;
  listening?: number | null;
  queued?: string | null;
  machine?: string;
  where?: string;
}

export interface Snapshot {
  now: number;
  version?: string;
  remoteMode?: boolean;
  quotas: {
    claude?: QuotaTool;
    codex?: QuotaTool;
    gemini?: QuotaTool;
  };
  active: SessionCard[];
  recent: SessionCard[];
  machines?: { name: string; ok: boolean; error?: string }[];
}

export interface SessionDetail extends SessionCard {
  cwd?: string;
  models?: string[];
  files?: [string, number][];
  canStop?: boolean;
  history?: { role: 'user' | 'assistant'; content: string; at?: number; tools?: string[] }[] | null;
  testRun?: { ok: boolean; command?: string; summary?: string; at?: number } | null;
}

export interface MachineCaps {
  name: string;
  online: boolean;
  platform?: string;
  home?: string;
  pinned?: string[];
  strictRemoteCwd?: boolean;
  cwds: string[];
  tools: Record<string, { models: { id: string; label: string }[] }>;
}

export interface FsEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
}

export interface GitInfo {
  ok: boolean;
  isRepo: boolean;
  branch: string;
  modified: { code: string; path: string }[];
  commits: { hash: string; date: string; message: string }[];
}

export interface ConflictError extends Error {
  status: 409;
  conflict: true;
  currentContent: unknown;
  currentHash: string;
}

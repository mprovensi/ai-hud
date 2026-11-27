export type CardTemplate = 'board' | 'research' | 'gallery';
export type CardStatus = 'idea' | 'spec' | 'in-progress' | 'review' | 'done';

export interface CardReviewMeta {
  status?: 'none' | 'approved' | 'changes';
  at?: number;
  summary?: string;
  reportPath?: string;
}

export interface CardCommitMeta {
  hash?: string;
  branch?: string;
  message?: string;
  at?: number;
}

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
  docRef?: string;
  phase?: string;
  review?: CardReviewMeta | null;
  commit?: CardCommitMeta | null;
  archived?: boolean;
  archivedAt?: number;
  updatedAt?: number;
}

export interface ProjectDocEntry {
  path: string;
  name: string;
  category: 'plan' | 'spec' | 'review' | 'doc';
  title: string;
  size: number;
  mtimeMs: number;
  taskCount: number;
  doneCount: number;
}

export interface GoldfishEstimate {
  ok: boolean;
  dryRun: true;
  docPath: string;
  engine: string;
  model: string;
  complexity?: 'simple' | 'standard' | 'complex';
  complexityReason?: string;
  reason: string;
  available: boolean;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  promptChars: number;
}

export interface GoldfishReviewResult {
  ok: boolean;
  docPath: string;
  engine: string;
  model: string;
  complexity?: 'simple' | 'standard' | 'complex';
  complexityReason?: string;
  durationMs: number;
  verdict: 'approved' | 'changes';
  summary: string;
  gaps: string[];
  risks: string[];
  cuts: string[];
  markdown: string;
  reportPath?: string;
  review?: CardReviewMeta;
  usage?: DreamUsage;
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
  group?: string;
  category?: string;
  status?: string;
  pinned?: boolean;
  hidden?: boolean;
  folder: string;
  storageMode?: 'in-project' | 'hub';
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

export interface WorkspaceGroupMeta {
  machine?: string;
  rootCwd?: string;
  hidden?: boolean;
}

export interface WorkspaceIndex {
  root: string;
  format: string;
  version: number;
  groups?: string[];
  groupMeta?: Record<string, WorkspaceGroupMeta>;
  entities: WorkspaceEntity[];
  context: GlobalDocItem[];
  knowledge: GlobalDocItem[];
  skills: GlobalDocItem[];
  handoffs: GlobalDocItem[];
}

export interface DreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  totalTokens: number;
  costUsd?: number | null;
  estimated?: boolean;
}

export interface UsageLogEntry extends DreamUsage {
  at: string;
  trigger?: 'auto' | 'manual';
  kind?: 'goldfish-review' | 'structure-from-docs';
  project?: string;
  docPath?: string;
  engine?: string;
  model?: string;
  verdict?: string;
  sessionsProcessed?: number;
  durationMs?: number;
  summary?: string;
}

export interface UsageAggregate {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  recent: UsageLogEntry[];
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
  lastUsage?: DreamUsage | null;
  pendingCount: number;
  pendingIds: string[];
}

export interface QuotaWindow {
  used: number;
  resetsAt?: number | string;
  pace?: number;
}

export interface QuotaTool {
  plan?: string;
  at?: number;
  error?: string;
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
  pinned?: boolean;
  alias?: string;
  group?: string;
  sharedSessionId?: string;
  handoffChain?: string[];
}

export interface BurnSeries {
  start?: number;
  end?: number;
  used?: number;
  window?: string;
  points?: { t: number; used: number }[];
  projected?: number | null;
  runsOutIn?: number | null;
}

export interface CostBucket {
  usd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SnapshotCosts {
  usdToBrl: number;
  fxSource?: string;
  fxUpdatedAt?: number;
  today?: Record<string, CostBucket>;
  week?: Record<string, CostBucket>;
  month?: Record<string, CostBucket>;
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
  burn?: {
    claude?: BurnSeries | null;
    codex?: BurnSeries | null;
    gemini?: BurnSeries | null;
  };
  today?: Record<string, { fresh: number; cacheRead: number }>;
  sessionsToday?: Record<string, number>;
  costs?: SnapshotCosts;
  active: SessionCard[];
  recent: SessionCard[];
  machines?: { name: string; ok: boolean; error?: string }[];
}

export interface SessionHistoryMsg {
  role: 'user' | 'assistant' | 'handoff';
  content: string;
  at?: number;
  tool?: string;
  fromTool?: string;
  toTool?: string;
  tools?: string[];
}

export interface QuotaHandoffSuggestion {
  reason: 'quota-full' | 'rate-limit';
  currentTool: string;
  currentUsed: number | null;
  suggestedTool: string;
  suggestedUsed: number | null;
  alternatives: { tool: string; used: number | null }[];
}

export interface SessionDetail extends SessionCard {
  cwd?: string;
  models?: string[];
  files?: [string, number][];
  canStop?: boolean;
  lastTool?: string;
  subagents?: number;
  permission?: { id: string; tool: string; summary?: string } | null;
  history?: SessionHistoryMsg[] | null;
  testRun?: { ok: boolean; command?: string; summary?: string; at?: number } | null;
  sharedSession?: { id: string; rev: number; tools: string[]; nativesCount: number } | null;
  quotaSuggestion?: QuotaHandoffSuggestion | null;
}

export interface MachineCaps {
  name: string;
  online: boolean;
  local?: boolean;
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

export interface RunProcessSpec {
  id: string;
  name: string;
  cmd: string;
  cwd?: string;
  gui?: boolean;
  openUrl?: string;
}

export interface RunProfile {
  id: string;
  name: string;
  kind: 'web' | 'gui' | 'compound' | 'service' | 'script';
  processes: RunProcessSpec[];
}

export interface ProjectRunConfig {
  format: string;
  version: number;
  defaultProfile: string;
  profiles: RunProfile[];
}

export interface RunProcessState {
  id: string;
  name: string;
  cmd: string;
  cwd?: string;
  gui?: boolean;
  pid: number;
  status: 'running' | 'stopped' | 'exited';
  ready?: boolean;
  readyReason?: string;
  expectsUrl?: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt: number;
  detectedUrls: string[];
  reachableUrls?: string[];
  logs: { ts: number; stream: 'out' | 'err' | 'sys'; text: string }[];
}

export interface ProjectRunStatus {
  ok: boolean;
  running: boolean;
  allReady?: boolean;
  bootState?: 'stopped' | 'starting' | 'ready' | 'degraded' | 'failed';
  openUrl?: string;
  profileId: string;
  profileName: string;
  kind: string;
  startedAt: number;
  processes: RunProcessState[];
}

export interface AutoConfigureRunResult {
  ok: boolean;
  alreadyConfigured: boolean;
  configured: boolean;
  engine?: string;
  model?: string;
  aiFallbackNote?: string;
  config: ProjectRunConfig;
  bootOk: boolean;
  bootState?: string;
  bootError?: string;
  openUrl?: string;
  processes?: RunProcessState[];
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

export interface WorkspaceSyncStatus {
  ok: boolean;
  isRepo: boolean;
  branch: string;
  remote: string;
  ahead: number;
  behind: number;
  dirty: number;
  conflicts: string[];
  syncing: boolean;
  lastSyncAt: number;
  lastError: string;
}

export type McpTarget = 'claude' | 'codex' | 'antigravity';
export type McpTargetState = 'synced' | 'outdated' | 'missing' | 'disabled' | 'stale';

export interface McpServerItem {
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
  targets: Record<McpTarget, boolean>;
  machines: string[];
  updatedAt?: number;
  secretKeys?: string[];
  missingSecrets?: string[];
  targetStatus?: Record<McpTarget, McpTargetState>;
}

export interface McpStatusResponse {
  ok: boolean;
  machine: string;
  catalogPath: string;
  cliPaths: Record<McpTarget, string>;
  cliExists: Record<McpTarget, boolean>;
  localSecretKeys: string[];
  managedIds: string[];
  servers: McpServerItem[];
  unmanaged: { id: string; transport: 'stdio' | 'http'; command?: string; url?: string; foundIn: McpTarget[] }[];
}

export type SkillTargetState = 'linked' | 'native' | 'plugin' | 'missing' | 'conflict' | 'other-link' | 'broken';

export interface SkillTargetInfo {
  status: SkillTargetState;
  linked: boolean;
  native: boolean;
  path: string;
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  cmd: string;
  description: string;
  origin: string;
  originKind: 'plugin' | 'workspace' | 'claude' | 'codex' | 'antigravity';
  plugin: string;
  sourceDir: string;
  skillFile: string;
  targets: Record<McpTarget, SkillTargetInfo>;
}

export interface PluginCatalogItem {
  id: string;
  name: string;
  marketplace: string;
  enabled: boolean;
  description: string;
  author: string;
  activePath: string;
  sourcePath: string;
  sourceVersion: string;
  cachePath: string;
  cacheVersion: string;
  outdated: boolean;
  canUpdateCache: boolean;
  agents: { name: string; path: string }[];
  skills: {
    name: string;
    cmd: string;
    description: string;
    sourceDir: string;
    targets: Record<McpTarget, SkillTargetInfo> | null;
  }[];
}

export interface SkillsCatalogResponse {
  ok: boolean;
  machine: string;
  cliDirs: Record<McpTarget, string>;
  workspaceRoots: { group: string; rootCwd: string }[];
  plugins: PluginCatalogItem[];
  skills: SkillCatalogItem[];
}

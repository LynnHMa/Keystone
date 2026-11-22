export type MemoryKind =
  | "world"
  | "experience"
  | "observation"
  | "correction"
  | "page"
  | "initiative";

export type HarnessName =
  | "claude-code"
  | "codex"
  | "dsh"
  | "antigravity-cli"
  | "cli"
  | "mcp"
  | string;

export interface MemoryDocument {
  id: string;
  bankId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  entities: string[];
  tags: string[];
  harness: HarnessName;
  source?: string;
  confidence: number;
  supersedes: string[];
  supersededBy?: string | null;
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  filePath: string; // relative to git repo root, POSIX slashes
  contentHash: string;
}

export interface EpisodeRecord {
  id: string;
  bankId: string;
  kind: "world" | "experience";
  title: string;
  content: string;
  entities: string[];
  tags: string[];
  harness: HarnessName;
  sessionId?: string;
  source?: string;
  confidence: number;
  createdAt: string;
}

export interface RecallResult {
  id: string;
  bankId: string;
  kind: MemoryKind;
  title: string;
  snippet: string;
  content: string;
  score: number;
  scoreBreakdown: {
    bm25: number;
    vector: number;
    graph: number;
    authority: number;
    recency: number;
  };
  entities: string[];
  tags: string[];
  harness: string;
  updatedAt: string;
  filePath: string;
  supersededBy?: string | null;
}

export interface BankMeta {
  bankId: string;
  repoName: string;
  remoteUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastSeedCommit?: string;
  tags?: string[];
}

export interface LlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  embeddingModel?: string;
  timeoutMs?: number;
}

export interface GitSyncConfig {
  remoteUrl?: string;
  branch: string;
  autoPush: boolean;
  autoRebaseOnPush: boolean;
  debounceMs: number;
  commitAuthorName?: string;
  commitAuthorEmail?: string;
}

export interface KeystoneConfig {
  repoDir: string;
  git: GitSyncConfig;
  llm?: LlmConfig;
  defaultBank?: string;
  globalBankId: string;
  autoInject: "pages" | "recall" | "both" | "none";
  maxInjectChars: number;
  redactSecrets: boolean;
  harnesses: Record<string, { disabled?: boolean; autoInject?: "pages" | "recall" | "both" | "none" }>;
}

export interface SyncStatusReport {
  repoDir: string;
  initialized: boolean;
  remoteUrl: string | null;
  branch: string;
  headCommit: string | null;
  dirtyFiles: string[];
  ahead: number;
  behind: number;
  pushPending: boolean;
  remoteAhead: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  totalIndexedDocs: number;
  bankStats?: {
    bankId: string;
    pages: number;
    initiatives: number;
    observations: number;
    corrections: number;
    episodes: number;
  };
}

export interface PullResult {
  ok: boolean;
  updatedFiles: string[];
  reindexedCount: number;
  removedCount: number;
  hadLocalSnapshot: boolean;
  conflictBranch?: string;
  message: string;
}

export interface PushResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
  remoteAhead?: boolean;
  commitHash?: string;
  message: string;
}

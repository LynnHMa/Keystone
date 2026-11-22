import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveBank, type ResolvedBank } from "./bank.js";
import { loadConfig, saveConfig } from "./config.js";
import { GitSyncManager } from "./git-sync.js";
import { LocalMemoryIndex } from "./index-db.js";
import { OptionalLlmClient } from "./llm.js";
import { GitMemoryStore } from "./store.js";
import type {
  KeystoneConfig,
  HarnessName,
  MemoryDocument,
  MemoryKind,
  PullResult,
  PushResult,
  RecallResult,
  SyncStatusReport
} from "./types.js";

export class KeystoneEngine {
  public readonly config: KeystoneConfig;
  public readonly store: GitMemoryStore;
  public readonly index: LocalMemoryIndex;
  public readonly sync: GitSyncManager;
  public readonly llm: OptionalLlmClient;

  constructor(configOverride?: KeystoneConfig) {
    this.config = configOverride ?? loadConfig();
    this.store = new GitMemoryStore(this.config.repoDir, this.config.redactSecrets);
    this.store.ensureBaseLayout();
    this.index = new LocalMemoryIndex(this.config.repoDir);
    this.sync = new GitSyncManager(this.config.repoDir, this.config.git, this.store, this.index);
    this.llm = new OptionalLlmClient(this.config.llm);
  }

  close(): void {
    this.index.close();
  }

  resolveBankForCwd(cwd?: string, explicitBankId?: string): ResolvedBank {
    return resolveBank(cwd, explicitBankId || this.config.defaultBank);
  }

  private cliPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "cli", "index.js");
  }

  private maybeSyncAfterWrite(reason: string, background = true): PushResult | null {
    if (!this.sync.isInitialized()) {
      this.sync.initRepo();
    }
    if (!this.config.git.autoPush) return null;
    if (background) {
      this.sync.triggerBackgroundPush(this.cliPath(), reason);
      return null;
    }
    return this.sync.commitAndPush(reason, { push: true });
  }

  /**
   * RETAIN: Persist a new World / Experience / Observation memory into Git + local SQLite index.
   */
  async retain(input: {
    cwd?: string;
    bankId?: string;
    kind?: "world" | "experience" | "observation";
    title: string;
    content: string;
    harness?: HarnessName;
    entities?: string[];
    tags?: string[];
    sessionId?: string;
    source?: string;
    supersedes?: string[];
    confidence?: number;
    syncMode?: "background" | "immediate" | "none";
  }): Promise<{ doc: MemoryDocument; pushResult: PushResult | null }> {
    const resolved = this.resolveBankForCwd(input.cwd, input.bankId);
    this.store.ensureBank(resolved.bankId, {
      repoName: resolved.repoName,
      remoteUrl: resolved.remoteUrl ?? undefined
    });

    const kind = input.kind ?? "experience";
    const harness = input.harness ?? "cli";
    const doc =
      kind === "observation"
        ? this.store.writeNote({
            bankId: resolved.bankId,
            kind: "observation",
            title: input.title,
            content: input.content,
            harness,
            entities: input.entities,
            tags: input.tags,
            supersedes: input.supersedes,
            confidence: input.confidence,
            source: input.source
          })
        : this.store.writeEpisode({
            bankId: resolved.bankId,
            kind,
            title: input.title,
            content: input.content,
            harness,
            entities: input.entities,
            tags: input.tags,
            sessionId: input.sessionId,
            source: input.source,
            confidence: input.confidence
          });

    const embedding = await this.llm.embed(`${doc.title}\n${doc.content}`);
    this.index.upsertDocument(doc, embedding);

    const reason = `mem(${resolved.bankId}): [${harness}] retain ${kind} - ${doc.title.slice(0, 60)}`;
    const mode = input.syncMode ?? "background";
    const pushResult =
      mode === "none" ? null : this.maybeSyncAfterWrite(reason, mode === "background");

    return { doc, pushResult };
  }

  /**
   * CORRECT: Write a highest-authority Correction record that supersedes stale facts.
   */
  async correct(input: {
    cwd?: string;
    bankId?: string;
    topic: string;
    wrongClaim: string;
    truth: string;
    evidence?: string;
    supersedes?: string[];
    harness?: HarnessName;
    syncMode?: "background" | "immediate" | "none";
  }): Promise<{ doc: MemoryDocument; pushResult: PushResult | null }> {
    const resolved = this.resolveBankForCwd(input.cwd, input.bankId);
    const harness = input.harness ?? "cli";
    const body = [
      `## Previous / Wrong Claim`,
      input.wrongClaim.trim(),
      "",
      `## Verified Current Truth`,
      input.truth.trim(),
      ...(input.evidence ? ["", "## Evidence", input.evidence.trim()] : [])
    ].join("\n");

    const doc = this.store.writeNote({
      bankId: resolved.bankId,
      kind: "correction",
      title: `Correction: ${input.topic}`,
      content: body,
      harness,
      supersedes: input.supersedes ?? [],
      confidence: 1.0,
      tags: ["correction"]
    });

    const embedding = await this.llm.embed(`${doc.title}\n${doc.content}`);
    this.index.upsertDocument(doc, embedding);

    const reason = `mem(${resolved.bankId}): [${harness}] correction - ${input.topic.slice(0, 60)}`;
    const mode = input.syncMode ?? "background";
    const pushResult =
      mode === "none" ? null : this.maybeSyncAfterWrite(reason, mode === "background");
    return { doc, pushResult };
  }

  /**
   * CAPTURE INITIATIVE: Create or update a living feature/project plan page in-place.
   */
  async captureInitiative(input: {
    cwd?: string;
    bankId?: string;
    title: string;
    summary: string;
    slug?: string;
    harness?: HarnessName;
    tags?: string[];
    syncMode?: "background" | "immediate" | "none";
  }): Promise<{ doc: MemoryDocument; pushResult: PushResult | null }> {
    const resolved = this.resolveBankForCwd(input.cwd, input.bankId);
    const harness = input.harness ?? "cli";
    const doc = this.store.upsertPage({
      bankId: resolved.bankId,
      kind: "initiative",
      slug: input.slug,
      title: input.title,
      content: `# ${input.title}\n\n${input.summary.trim()}`,
      harness,
      tags: [...(input.tags ?? []), "initiative"]
    });

    const embedding = await this.llm.embed(`${doc.title}\n${doc.content}`);
    this.index.upsertDocument(doc, embedding);

    const reason = `mem(${resolved.bankId}): [${harness}] initiative - ${input.title.slice(0, 60)}`;
    const mode = input.syncMode ?? "background";
    const pushResult =
      mode === "none" ? null : this.maybeSyncAfterWrite(reason, mode === "background");
    return { doc, pushResult };
  }

  /**
   * UPSERT PAGE: Create or refresh a curated Mental Model / Wiki page (e.g. architecture, conventions, decisions).
   */
  async upsertPage(input: {
    cwd?: string;
    bankId?: string;
    slug?: string;
    title: string;
    content: string;
    harness?: HarnessName;
    tags?: string[];
    evidenceIds?: string[];
    syncMode?: "background" | "immediate" | "none";
  }): Promise<{ doc: MemoryDocument; pushResult: PushResult | null }> {
    const resolved = this.resolveBankForCwd(input.cwd, input.bankId);
    const harness = input.harness ?? "cli";
    const doc = this.store.upsertPage({
      bankId: resolved.bankId,
      kind: "page",
      slug: input.slug,
      title: input.title,
      content: input.content,
      harness,
      tags: input.tags,
      evidenceIds: input.evidenceIds
    });

    const embedding = await this.llm.embed(`${doc.title}\n${doc.content}`);
    this.index.upsertDocument(doc, embedding);

    const reason = `mem(${resolved.bankId}): [${harness}] page - ${input.title.slice(0, 60)}`;
    const mode = input.syncMode ?? "background";
    const pushResult =
      mode === "none" ? null : this.maybeSyncAfterWrite(reason, mode === "background");
    return { doc, pushResult };
  }

  /**
   * RECALL: 4-way hybrid search across current repo's Memory Bank + Global Bank.
   */
  async recall(input: {
    query: string;
    cwd?: string;
    bankId?: string;
    includeGlobal?: boolean;
    kinds?: MemoryKind[];
    limit?: number;
  }): Promise<{ bank: ResolvedBank; results: RecallResult[] }> {
    const bank = this.resolveBankForCwd(input.cwd, input.bankId);
    const bankIds = [bank.bankId];
    if ((input.includeGlobal ?? true) && bank.bankId !== this.config.globalBankId) {
      bankIds.push(this.config.globalBankId);
    }

    // Ensure local SQLite index isn't empty when Git repo already has files
    if (this.index.getTotalCount() === 0 && this.store.listAllMemoryFiles().length > 0) {
      this.index.fullReindex(this.store);
    }

    const queryEmbedding = await this.llm.embed(input.query);
    const results = this.index.recall({
      query: input.query,
      bankIds,
      kinds: input.kinds,
      limit: input.limit ?? 8,
      queryEmbedding
    });
    return { bank, results };
  }

  /**
   * REFLECT: Deep synthesis over recalled memories.
   * Uses configured LLM if available; otherwise produces a structured deterministic synthesis
   * prioritizing Corrections -> Mental Model Pages -> Observations -> Episodes.
   */
  async reflect(input: {
    query: string;
    cwd?: string;
    bankId?: string;
    limit?: number;
  }): Promise<{ bank: ResolvedBank; synthesis: string; evidence: RecallResult[]; usedLlm: boolean }> {
    const { bank, results } = await this.recall({
      query: input.query,
      cwd: input.cwd,
      bankId: input.bankId,
      limit: input.limit ?? 12
    });

    if (results.length === 0) {
      return {
        bank,
        synthesis: `No matching memories found in bank '${bank.bankId}' (or global) for: "${input.query}".`,
        evidence: [],
        usedLlm: false
      };
    }

    const llmAnswer = await this.llm.reflect(input.query, results);
    if (llmAnswer) {
      return { bank, synthesis: llmAnswer, evidence: results, usedLlm: true };
    }

    // Deterministic structured reflection (zero external API required)
    const grouped: Record<string, RecallResult[]> = {
      correction: [],
      page: [],
      initiative: [],
      observation: [],
      world: [],
      experience: []
    };
    for (const r of results) {
      (grouped[r.kind] ??= []).push(r);
    }

    const sections: string[] = [`# Reflection on "${input.query}" (bank: ${bank.bankId})`];
    const labels: Array<[MemoryKind, string]> = [
      ["correction", "Verified Corrections (Highest Authority)"],
      ["page", "Mental Model Pages"],
      ["initiative", "Active Initiatives & Plans"],
      ["observation", "Consolidated Observations"],
      ["world", "World Facts"],
      ["experience", "Recent Experiences"]
    ];

    for (const [kind, label] of labels) {
      const items = grouped[kind];
      if (!items || items.length === 0) continue;
      sections.push(`\n## ${label}`);
      for (const item of items) {
        sections.push(
          `- **[${item.title}]** (\`${item.id}\`, harness: \`${item.harness}\`, score: ${item.score})\n  ${item.snippet}`
        );
      }
    }

    return {
      bank,
      synthesis: sections.join("\n"),
      evidence: results,
      usedLlm: false
    };
  }

  /**
   * Seeds a repository's Memory Bank with recent git commit history (Hindsight-style auto-seed).
   */
  async seedGitHistory(cwd: string, limit = 60): Promise<{ seeded: boolean; commitCount: number; bankId: string }> {
    const bank = this.resolveBankForCwd(cwd);
    if (!bank.repoRoot) {
      return { seeded: false, commitCount: 0, bankId: bank.bankId };
    }

    let rawLog = "";
    try {
      rawLog = execFileSync(
        "git",
        ["log", `-n`, String(limit), "--date=short", "--pretty=format:%h | %ad | %an | %s"],
        { cwd: bank.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
      ).trim();
    } catch {
      return { seeded: false, commitCount: 0, bankId: bank.bankId };
    }

    if (!rawLog) return { seeded: false, commitCount: 0, bankId: bank.bankId };
    const lines = rawLog.split(/\r?\n/);

    await this.upsertPage({
      cwd: bank.repoRoot,
      bankId: bank.bankId,
      slug: "git-history-seed",
      title: `Git History Seed (${bank.repoName})`,
      content: `# Recent Git Commits (${lines.length})\n\n\`\`\`text\n${rawLog}\n\`\`\``,
      harness: "cli",
      tags: ["seed", "git-history"],
      syncMode: "background"
    });

    return { seeded: true, commitCount: lines.length, bankId: bank.bankId };
  }

  /**
   * Builds a compact prompt injection block once per session for coding-agent hooks
   * (Claude / Codex / dsh / Antigravity), preventing per-turn context flooding.
   */
  async buildContextInjection(opts: {
    cwd?: string;
    prompt: string;
    harness: HarnessName;
    sessionId?: string;
  }): Promise<string | null> {
    const harnessCfg = this.config.harnesses[opts.harness];
    if (harnessCfg?.disabled) return null;
    const mode = harnessCfg?.autoInject ?? this.config.autoInject;
    if (mode === "none") return null;

    if (opts.sessionId) {
      const stateKey = `injected_session:${opts.harness}:${opts.sessionId}`;
      if (this.index.getState(stateKey) === "true") {
        return null;
      }
      this.index.setState(stateKey, "true");
    }

    const bank = this.resolveBankForCwd(opts.cwd);
    const bankIds =
      bank.bankId === this.config.globalBankId
        ? [bank.bankId]
        : [bank.bankId, this.config.globalBankId];

    const parts: string[] = [];
    const status = this.sync.getSyncStatus(bank.bankId);

    const headerBits = [`🧠 Keystone Memory (bank: \`${bank.bankId}\`)`];
    if (status.remoteAhead) {
      headerBits.push(`⚠️ Remote has newer commits — call \`keystone_pull\` or run \`keystone pull\``);
    }
    parts.push(headerBits.join(" | "));

    let hasContent = status.remoteAhead;

    if (mode === "pages" || mode === "both") {
      const pages = this.index.listPages(bankIds).slice(0, 8);
      if (pages.length > 0) {
        let roster = "### Mental Model Pages:\n";
        for (const p of pages) {
          const line = `- \`${p.id}\` (${p.kind}): ${p.title}\n`;
          if (roster.length + line.length > 1200) break;
          roster += line;
        }
        parts.push(roster.trimEnd());
        hasContent = true;
      }
    }

    const trimmedPrompt = opts.prompt.trim();
    if ((mode === "recall" || mode === "both") && trimmedPrompt.length > 10) {
      const { results } = await this.recall({
        query: trimmedPrompt,
        cwd: opts.cwd,
        limit: 4
      });
      if (results.length > 0) {
        parts.push(
          "### Relevant Recalled Memories:\n" +
            results
              .map(
                (r) =>
                  `- [${r.kind.toUpperCase()}] **${r.title}** (\`${r.id}\`, from \`${r.harness}\`): ${r.snippet.slice(0, 220)}`
              )
              .join("\n")
        );
        hasContent = true;
      }
    }

    if (!hasContent) return null;
    parts.push("Need deeper history? Call `keystone_recall`, `keystone_search_pages`, or `keystone_read_page` on demand.");
    const joined = parts.join("\n\n");
    return joined.slice(0, this.config.maxInjectChars);
  }

  /**
   * Retains a coding-agent session transcript with per-session watermark deduplication:
   * - Identical content hash -> immediate no-op (0 writes, 0 commits).
   * - Same sessionId with new turns -> updates its single canonical episode file in-place.
   * - Optional LLM distillation only processes the incremental delta past the last cursor.
   */
  async retainSessionTranscript(input: {
    cwd?: string;
    harness: HarnessName;
    sessionId: string;
    transcriptSummary: string;
    syncMode?: "background" | "immediate" | "none";
  }): Promise<number> {
    const clean = input.transcriptSummary.trim();
    if (clean.length < 40) return 0;

    const bank = this.resolveBankForCwd(input.cwd);
    const stateScope = `${bank.bankId}:${input.harness}:${input.sessionId}`;
    const hashKey = `session_hash:${stateScope}`;
    const fileKey = `session_file:${stateScope}`;
    const cursorKey = `session_cursor:${stateScope}`;

    const contentHash = createHash("sha256").update(clean, "utf8").digest("hex").slice(0, 16);
    if (this.index.getState(hashKey) === contentHash) {
      return 0;
    }

    // Optional LLM distillation: only distill incremental delta when possible
    if (this.llm.isConfigured()) {
      const prevCursor = Number(this.index.getState(cursorKey) ?? "0");
      const delta = prevCursor > 0 && clean.length > prevCursor ? clean.slice(prevCursor).trim() : clean;
      const distilled = delta.length >= 40 ? await this.llm.distillSession(delta) : null;
      if (distilled && distilled.length > 0) {
        let count = 0;
        for (const item of distilled.slice(0, 6)) {
          await this.retain({
            cwd: input.cwd,
            kind: item.kind,
            title: item.title,
            content: item.content,
            entities: item.entities,
            tags: [...(item.tags ?? []), "distilled"],
            harness: input.harness,
            sessionId: input.sessionId,
            syncMode: "none"
          });
          count++;
        }
        this.index.setState(hashKey, contentHash);
        this.index.setState(cursorKey, String(clean.length));
        const mode = input.syncMode ?? "background";
        if (mode !== "none") {
          this.maybeSyncAfterWrite(
            `mem(${bank.bankId}): [${input.harness}] distill ${count} memories from session ${input.sessionId.slice(0, 8)}`,
            mode === "background"
          );
        }
        return count;
      }
    }

    // Deterministic mode: update one canonical file per sessionId in-place (zero duplicate snapshots)
    this.store.ensureBank(bank.bankId, {
      repoName: bank.repoName,
      remoteUrl: bank.remoteUrl ?? undefined
    });

    const firstLine =
      clean
        .split(/\r?\n/)
        .find((l) => l.trim().length > 4)
        ?.replace(/^(?:User|Assistant):\s*/i, "")
        .slice(0, 72) || `Session ${input.sessionId.slice(0, 8)}`;

    const existingFilePath = this.index.getState(fileKey);
    const doc = this.store.upsertSessionEpisode({
      bankId: bank.bankId,
      sessionId: input.sessionId,
      title: `[${input.harness}] ${firstLine}`,
      content: clean.slice(0, 8000),
      harness: input.harness,
      existingFilePath,
      tags: ["session-capture"]
    });

    const embedding = await this.llm.embed(`${doc.title}\n${doc.content}`);
    this.index.upsertDocument(doc, embedding);
    this.index.setState(hashKey, contentHash);
    this.index.setState(fileKey, doc.filePath);

    const mode = input.syncMode ?? "background";
    if (mode !== "none") {
      this.maybeSyncAfterWrite(
        `mem(${bank.bankId}): [${input.harness}] sync session ${input.sessionId.slice(0, 8)}`,
        mode === "background"
      );
    }
    return 1;
  }

  listPages(cwd?: string, bankId?: string): MemoryDocument[] {
    const bank = this.resolveBankForCwd(cwd, bankId);
    const ids =
      bank.bankId === this.config.globalBankId
        ? [bank.bankId]
        : [bank.bankId, this.config.globalBankId];
    return this.index.listPages(ids);
  }

  readPage(idOrSlug: string, cwd?: string, bankId?: string): MemoryDocument | null {
    const bank = this.resolveBankForCwd(cwd, bankId);
    const ids =
      bank.bankId === this.config.globalBankId
        ? [bank.bankId]
        : [bank.bankId, this.config.globalBankId];
    return this.index.getDocByIdOrSlug(ids, idOrSlug);
  }

  pull(opts?: { pushAfter?: boolean }): PullResult {
    return this.sync.manualPull(opts);
  }

  push(reason = "mem(sync): manual push"): PushResult {
    return this.sync.commitAndPush(reason, { push: true });
  }

  syncStatus(cwd?: string, bankId?: string): SyncStatusReport {
    const bank = this.resolveBankForCwd(cwd, bankId);
    return this.sync.getSyncStatus(bank.bankId);
  }

  init(remoteUrl?: string): { initialized: boolean; cloned: boolean; message: string } {
    if (remoteUrl) {
      this.config.git.remoteUrl = remoteUrl;
      saveConfig(this.config);
    }
    return this.sync.initRepo(remoteUrl);
  }

  bind(remoteUrl: string): void {
    this.config.git.remoteUrl = remoteUrl;
    saveConfig(this.config);
    if (!this.sync.isInitialized()) {
      this.sync.initRepo(remoteUrl);
    } else {
      this.sync.bindRemote(remoteUrl);
    }
  }
}

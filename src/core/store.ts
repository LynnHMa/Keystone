import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sanitizeSlug } from "./bank.js";
import { extractEntities } from "./entities.js";
import { parseFrontmatter, serializeFrontmatter } from "./markdown.js";
import { redactSecrets } from "./redact.js";
import type { BankMeta, EpisodeRecord, HarnessName, MemoryDocument, MemoryKind } from "./types.js";
import { ulid } from "./ulid.js";

function toPosix(relPath: string): string {
  return relPath.split(sep).join("/");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function bankRootDir(repoDir: string, bankId: string): string {
  if (bankId === "global") {
    return join(repoDir, "global");
  }
  return join(repoDir, "banks", sanitizeSlug(bankId));
}

export class GitMemoryStore {
  constructor(
    public readonly repoDir: string,
    private readonly redactEnabled = true
  ) {}

  ensureBaseLayout(): void {
    mkdirSync(this.repoDir, { recursive: true });
    mkdirSync(join(this.repoDir, ".cache"), { recursive: true });
    mkdirSync(join(this.repoDir, "global", "pages"), { recursive: true });
    mkdirSync(join(this.repoDir, "global", "observations"), { recursive: true });
    mkdirSync(join(this.repoDir, "global", "corrections"), { recursive: true });
    mkdirSync(join(this.repoDir, "global", "episodes"), { recursive: true });
    mkdirSync(join(this.repoDir, "banks"), { recursive: true });

    const gitignorePath = join(this.repoDir, ".gitignore");
    const requiredIgnores = [".cache/", "*.lock", "*.tmp", "index.sqlite*"];
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, requiredIgnores.join("\n") + "\n", "utf8");
    } else {
      const existing = readFileSync(gitignorePath, "utf8");
      const missing = requiredIgnores.filter((line) => !existing.includes(line));
      if (missing.length > 0) {
        appendFileSync(gitignorePath, "\n" + missing.join("\n") + "\n", "utf8");
      }
    }

    const manifestPath = join(this.repoDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            format: "keystone-hindsight-v1",
            createdAt: new Date().toISOString()
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
    }
  }

  ensureBank(bankId: string, meta?: Partial<BankMeta>): BankMeta {
    this.ensureBaseLayout();
    const dir = bankRootDir(this.repoDir, bankId);
    for (const sub of ["pages", "pages/initiatives", "observations", "corrections", "episodes"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    const metaPath = join(dir, "bank.json");
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as BankMeta;
        const nextRepoName = meta?.repoName ?? parsed.repoName ?? bankId;
        const nextRemoteUrl = meta?.remoteUrl ?? parsed.remoteUrl;
        if (nextRepoName === parsed.repoName && nextRemoteUrl === parsed.remoteUrl) {
          return parsed;
        }
        const updated: BankMeta = {
          ...parsed,
          repoName: nextRepoName,
          remoteUrl: nextRemoteUrl,
          updatedAt: new Date().toISOString()
        };
        writeFileSync(metaPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
        return updated;
      } catch {
        // Rewrite corrupted meta below
      }
    }

    const now = new Date().toISOString();
    const fresh: BankMeta = {
      bankId,
      repoName: meta?.repoName ?? bankId,
      remoteUrl: meta?.remoteUrl,
      createdAt: now,
      updatedAt: now
    };
    writeFileSync(metaPath, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    return fresh;
  }

  private cleanText(raw: string): string {
    return redactSecrets(raw, this.redactEnabled).text;
  }

  /**
   * Appends a conflict-free episode file (World or Experience) under episodes/YYYY-MM/.
   * Uses ULID + harness suffix so concurrent multi-device writes never conflict in Git.
   */
  writeEpisode(input: {
    bankId: string;
    kind: "world" | "experience";
    title: string;
    content: string;
    harness: HarnessName;
    entities?: string[];
    tags?: string[];
    sessionId?: string;
    source?: string;
    confidence?: number;
  }): MemoryDocument {
    this.ensureBank(input.bankId);
    const id = `ep_${ulid()}`;
    const now = new Date().toISOString();
    const ym = now.slice(0, 7);
    const title = this.cleanText(input.title.trim() || "Untitled episode");
    const content = this.cleanText(input.content.trim());
    const entities =
      input.entities && input.entities.length > 0
        ? input.entities
        : extractEntities(`${title}\n${content}`);
    const tags = [...new Set([...(input.tags ?? []), `harness:${input.harness}`, `kind:${input.kind}`])];

    const record: EpisodeRecord = {
      id,
      bankId: input.bankId,
      kind: input.kind,
      title,
      content,
      entities,
      tags,
      harness: input.harness,
      sessionId: input.sessionId,
      source: input.source,
      confidence: input.confidence ?? 0.8,
      createdAt: now
    };

    const safeHarness = sanitizeSlug(input.harness);
    const absDir = join(bankRootDir(this.repoDir, input.bankId), "episodes", ym);
    mkdirSync(absDir, { recursive: true });
    const absPath = join(absDir, `${id}_${safeHarness}.jsonl`);
    const serialized = JSON.stringify(record) + "\n";
    writeFileSync(absPath, serialized, "utf8");

    return {
      id,
      bankId: input.bankId,
      kind: input.kind,
      title,
      content,
      entities,
      tags,
      harness: input.harness,
      source: input.source,
      confidence: record.confidence,
      supersedes: [],
      supersededBy: null,
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
      filePath: toPosix(relative(this.repoDir, absPath)),
      contentHash: sha256(serialized)
    };
  }

  /**
   * Writes a consolidated Observation or high-priority Correction as human-readable Markdown.
   */
  writeNote(input: {
    bankId: string;
    kind: "observation" | "correction";
    title: string;
    content: string;
    harness: HarnessName;
    entities?: string[];
    tags?: string[];
    supersedes?: string[];
    evidenceIds?: string[];
    confidence?: number;
    source?: string;
  }): MemoryDocument {
    this.ensureBank(input.bankId);
    const prefix = input.kind === "correction" ? "corr" : "obs";
    const id = `${prefix}_${ulid()}`;
    const now = new Date().toISOString();
    const title = this.cleanText(input.title.trim());
    const content = this.cleanText(input.content.trim());
    const entities =
      input.entities && input.entities.length > 0
        ? input.entities
        : extractEntities(`${title}\n${content}`);
    const tags = [...new Set([...(input.tags ?? []), `harness:${input.harness}`, `kind:${input.kind}`])];
    const supersedes = input.supersedes ?? [];
    const evidenceIds = input.evidenceIds ?? [];
    const confidence = input.confidence ?? (input.kind === "correction" ? 1.0 : 0.9);

    const folder = input.kind === "correction" ? "corrections" : "observations";
    const absPath = join(bankRootDir(this.repoDir, input.bankId), folder, `${id}.md`);
    mkdirSync(dirname(absPath), { recursive: true });

    const md = serializeFrontmatter(
      {
        id,
        bank_id: input.bankId,
        kind: input.kind,
        title,
        harness: input.harness,
        source: input.source ?? null,
        confidence,
        entities,
        tags,
        supersedes,
        evidence_ids: evidenceIds,
        created_at: now,
        updated_at: now
      },
      `# ${title}\n\n${content}`
    );
    writeFileSync(absPath, md, "utf8");

    return {
      id,
      bankId: input.bankId,
      kind: input.kind,
      title,
      content,
      entities,
      tags,
      harness: input.harness,
      source: input.source,
      confidence,
      supersedes,
      supersededBy: null,
      evidenceIds,
      createdAt: now,
      updatedAt: now,
      filePath: toPosix(relative(this.repoDir, absPath)),
      contentHash: sha256(md)
    };
  }

  /**
   * Upserts a curated Mental Model Page or living Initiative Page in-place.
   */
  upsertPage(input: {
    bankId: string;
    kind: "page" | "initiative";
    slug?: string;
    title: string;
    content: string;
    harness: HarnessName;
    entities?: string[];
    tags?: string[];
    evidenceIds?: string[];
  }): MemoryDocument {
    this.ensureBank(input.bankId);
    const slug = sanitizeSlug(input.slug || input.title);
    const subDir = input.kind === "initiative" ? join("pages", "initiatives") : "pages";
    const absPath = join(bankRootDir(this.repoDir, input.bankId), subDir, `${slug}.md`);
    mkdirSync(dirname(absPath), { recursive: true });

    const now = new Date().toISOString();
    let createdAt = now;
    let id = `${input.kind === "initiative" ? "init" : "page"}_${slug}`;
    let prevEvidence: string[] = [];

    if (existsSync(absPath)) {
      const existing = parseFrontmatter(readFileSync(absPath, "utf8"));
      if (typeof existing.meta.id === "string") id = existing.meta.id;
      if (typeof existing.meta.created_at === "string") createdAt = existing.meta.created_at;
      if (Array.isArray(existing.meta.evidence_ids)) prevEvidence = existing.meta.evidence_ids;
    }

    const title = this.cleanText(input.title.trim());
    const content = this.cleanText(input.content.trim());
    const entities =
      input.entities && input.entities.length > 0
        ? input.entities
        : extractEntities(`${title}\n${content}`);
    const tags = [...new Set([...(input.tags ?? []), `harness:${input.harness}`, `kind:${input.kind}`])];
    const evidenceIds = [...new Set([...prevEvidence, ...(input.evidenceIds ?? [])])];

    const md = serializeFrontmatter(
      {
        id,
        bank_id: input.bankId,
        kind: input.kind,
        slug,
        title,
        harness: input.harness,
        confidence: 0.95,
        entities,
        tags,
        evidence_ids: evidenceIds,
        created_at: createdAt,
        updated_at: now
      },
      content
    );
    writeFileSync(absPath, md, "utf8");

    return {
      id,
      bankId: input.bankId,
      kind: input.kind,
      title,
      content,
      entities,
      tags,
      harness: input.harness,
      confidence: 0.95,
      supersedes: [],
      supersededBy: null,
      evidenceIds,
      createdAt,
      updatedAt: now,
      filePath: toPosix(relative(this.repoDir, absPath)),
      contentHash: sha256(md)
    };
  }

  /**
   * Parses any single Git-tracked memory file (.md or .jsonl) into MemoryDocument(s).
   */
  parseFile(relPosixPath: string): MemoryDocument[] {
    const absPath = join(this.repoDir, ...relPosixPath.split("/"));
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return [];

    const raw = readFileSync(absPath, "utf8");
    const hash = sha256(raw);

    if (relPosixPath.endsWith(".jsonl")) {
      const docs: MemoryDocument[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as EpisodeRecord;
          if (!rec.id || !rec.content) continue;
          docs.push({
            id: rec.id,
            bankId: rec.bankId || inferBankFromPath(relPosixPath),
            kind: rec.kind === "world" ? "world" : "experience",
            title: rec.title || rec.id,
            content: rec.content,
            entities: Array.isArray(rec.entities) ? rec.entities : extractEntities(rec.content),
            tags: Array.isArray(rec.tags) ? rec.tags : [],
            harness: rec.harness || "unknown",
            source: rec.source,
            confidence: typeof rec.confidence === "number" ? rec.confidence : 0.8,
            supersedes: [],
            supersededBy: null,
            evidenceIds: [],
            createdAt: rec.createdAt || new Date().toISOString(),
            updatedAt: rec.createdAt || new Date().toISOString(),
            filePath: relPosixPath,
            contentHash: hash
          });
        } catch {
          // Skip malformed line
        }
      }
      return docs;
    }

    if (relPosixPath.endsWith(".md")) {
      const { meta, body } = parseFrontmatter(raw);
      const bankId =
        typeof meta.bank_id === "string" ? meta.bank_id : inferBankFromPath(relPosixPath);
      const kind = inferKindFromPath(relPosixPath, meta.kind);
      const fallbackTitle =
        body.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
        relPosixPath.split("/").pop()?.replace(/\.md$/, "") ||
        "Untitled";
      const title = typeof meta.title === "string" && meta.title ? meta.title : fallbackTitle;
      const id =
        typeof meta.id === "string" && meta.id
          ? meta.id
          : `${kind}_${sanitizeSlug(relPosixPath)}`;
      const now = new Date().toISOString();

      return [
        {
          id,
          bankId,
          kind,
          title,
          content: body.trim(),
          entities: Array.isArray(meta.entities)
            ? meta.entities
            : extractEntities(`${title}\n${body}`),
          tags: Array.isArray(meta.tags) ? meta.tags : [],
          harness: typeof meta.harness === "string" ? meta.harness : "manual",
          source: typeof meta.source === "string" ? meta.source : undefined,
          confidence: typeof meta.confidence === "number" ? meta.confidence : 0.9,
          supersedes: Array.isArray(meta.supersedes) ? meta.supersedes : [],
          supersededBy: null,
          evidenceIds: Array.isArray(meta.evidence_ids) ? meta.evidence_ids : [],
          createdAt: typeof meta.created_at === "string" ? meta.created_at : now,
          updatedAt: typeof meta.updated_at === "string" ? meta.updated_at : now,
          filePath: relPosixPath,
          contentHash: hash
        }
      ];
    }

    return [];
  }

  /**
   * Lists all memory files inside global/ and banks/ (POSIX relative paths).
   */
  listAllMemoryFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === ".cache") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".jsonl"))) {
          const rel = toPosix(relative(this.repoDir, full));
          if (rel.startsWith("global/") || rel.startsWith("banks/")) {
            out.push(rel);
          }
        }
      }
    };
    walk(join(this.repoDir, "global"));
    walk(join(this.repoDir, "banks"));
    return out;
  }

  listBanks(): string[] {
    const banks = new Set<string>();
    if (existsSync(join(this.repoDir, "global"))) banks.add("global");
    const banksDir = join(this.repoDir, "banks");
    if (existsSync(banksDir)) {
      for (const entry of readdirSync(banksDir, { withFileTypes: true })) {
        if (entry.isDirectory()) banks.add(entry.name);
      }
    }
    return [...banks].sort();
  }
}

function inferBankFromPath(relPosixPath: string): string {
  if (relPosixPath.startsWith("global/")) return "global";
  const m = relPosixPath.match(/^banks\/([^/]+)\//);
  return m ? m[1] : "global";
}

function inferKindFromPath(relPosixPath: string, metaKind: unknown): MemoryKind {
  if (
    metaKind === "world" ||
    metaKind === "experience" ||
    metaKind === "observation" ||
    metaKind === "correction" ||
    metaKind === "page" ||
    metaKind === "initiative"
  ) {
    return metaKind;
  }
  if (relPosixPath.includes("/corrections/")) return "correction";
  if (relPosixPath.includes("/observations/")) return "observation";
  if (relPosixPath.includes("/pages/initiatives/")) return "initiative";
  if (relPosixPath.includes("/pages/")) return "page";
  return "experience";
}

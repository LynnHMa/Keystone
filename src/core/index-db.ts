import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSearchTokens, extractEntities } from "./entities.js";
import type { GitMemoryStore } from "./store.js";
import type { MemoryDocument, MemoryKind, RecallResult } from "./types.js";

const KIND_AUTHORITY: Record<MemoryKind, number> = {
  correction: 1.5,
  page: 1.25,
  initiative: 1.2,
  observation: 1.05,
  world: 0.9,
  experience: 0.85
};

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function buildFtsQuery(rawQuery: string): string {
  const tokenStr = buildSearchTokens(rawQuery);
  const terms = [...new Set(tokenStr.split(/\s+/).filter((t) => t.length >= 1))].slice(0, 24);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function makeSnippet(content: string, query: string, maxLen = 360): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const lower = clean.toLowerCase();
  let bestIdx = 0;
  for (const w of words) {
    const idx = lower.indexOf(w);
    if (idx !== -1) {
      bestIdx = Math.max(0, idx - 60);
      break;
    }
  }
  const slice = clean.slice(bestIdx, bestIdx + maxLen);
  return (bestIdx > 0 ? "..." : "") + slice + (bestIdx + maxLen < clean.length ? "..." : "");
}

interface DocRow {
  id: string;
  bank_id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  entities_json: string;
  tags_json: string;
  harness: string;
  source: string | null;
  confidence: number;
  supersedes_json: string;
  superseded_by: string | null;
  evidence_ids_json: string;
  created_at: string;
  updated_at: string;
  file_path: string;
  content_hash: string;
  embedding_json: string | null;
}

export class LocalMemoryIndex {
  private readonly dbPath: string;
  private db: DatabaseSync;

  constructor(repoDir: string) {
    this.dbPath = join(repoDir, ".cache", "index.sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        entities_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        harness TEXT NOT NULL DEFAULT 'unknown',
        source TEXT,
        confidence REAL NOT NULL DEFAULT 0.85,
        supersedes_json TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_docs_bank_kind ON docs(bank_id, kind);
      CREATE INDEX IF NOT EXISTS idx_docs_file_path ON docs(file_path);
      CREATE INDEX IF NOT EXISTS idx_docs_updated ON docs(updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        doc_id UNINDEXED,
        bank_id UNINDEXED,
        title_tokens,
        body_tokens,
        entity_tokens
      );

      CREATE TABLE IF NOT EXISTS doc_entities (
        entity TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        PRIMARY KEY (entity, doc_id)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_entities_lookup ON doc_entities(bank_id, entity);
      CREATE INDEX IF NOT EXISTS idx_doc_entities_doc ON doc_entities(doc_id);

      CREATE TABLE IF NOT EXISTS kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  upsertDocument(doc: MemoryDocument, embedding?: number[] | null): void {
    const existing = this.db
      .prepare("SELECT content_hash, embedding_json FROM docs WHERE id = ?")
      .get(doc.id) as { content_hash: string; embedding_json: string | null } | undefined;

    const embeddingJson =
      embedding && embedding.length > 0
        ? JSON.stringify(embedding)
        : existing && existing.content_hash === doc.contentHash
          ? existing.embedding_json
          : null;

    this.db
      .prepare(
        `INSERT INTO docs (
          id, bank_id, kind, title, content, entities_json, tags_json, harness, source,
          confidence, supersedes_json, superseded_by, evidence_ids_json,
          created_at, updated_at, file_path, content_hash, embedding_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          bank_id = excluded.bank_id,
          kind = excluded.kind,
          title = excluded.title,
          content = excluded.content,
          entities_json = excluded.entities_json,
          tags_json = excluded.tags_json,
          harness = excluded.harness,
          source = excluded.source,
          confidence = excluded.confidence,
          supersedes_json = excluded.supersedes_json,
          evidence_ids_json = excluded.evidence_ids_json,
          updated_at = excluded.updated_at,
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          embedding_json = COALESCE(excluded.embedding_json, docs.embedding_json)`
      )
      .run(
        doc.id,
        doc.bankId,
        doc.kind,
        doc.title,
        doc.content,
        JSON.stringify(doc.entities),
        JSON.stringify(doc.tags),
        doc.harness,
        doc.source ?? null,
        doc.confidence,
        JSON.stringify(doc.supersedes),
        doc.supersededBy ?? null,
        JSON.stringify(doc.evidenceIds),
        doc.createdAt,
        doc.updatedAt,
        doc.filePath,
        doc.contentHash,
        embeddingJson
      );

    // Refresh FTS5 entry
    this.db.prepare("DELETE FROM docs_fts WHERE doc_id = ?").run(doc.id);
    this.db
      .prepare(
        "INSERT INTO docs_fts (doc_id, bank_id, title_tokens, body_tokens, entity_tokens) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        doc.id,
        doc.bankId,
        buildSearchTokens(doc.title),
        buildSearchTokens(doc.content),
        buildSearchTokens(doc.entities.join(" "))
      );

    // Refresh entity edges
    this.db.prepare("DELETE FROM doc_entities WHERE doc_id = ?").run(doc.id);
    const insEntity = this.db.prepare(
      "INSERT OR IGNORE INTO doc_entities (entity, doc_id, bank_id) VALUES (?, ?, ?)"
    );
    for (const ent of doc.entities) {
      insEntity.run(ent.toLowerCase(), doc.id, doc.bankId);
    }

    // Apply supersedes links
    if (doc.supersedes.length > 0) {
      const mark = this.db.prepare("UPDATE docs SET superseded_by = ? WHERE id = ?");
      for (const oldId of doc.supersedes) {
        mark.run(doc.id, oldId);
      }
    }
  }

  removeByFilePath(relPosixPath: string): number {
    const rows = this.db
      .prepare("SELECT id FROM docs WHERE file_path = ?")
      .all(relPosixPath) as Array<{ id: string }>;
    if (rows.length === 0) return 0;

    const delDoc = this.db.prepare("DELETE FROM docs WHERE id = ?");
    const delFts = this.db.prepare("DELETE FROM docs_fts WHERE doc_id = ?");
    const delEnt = this.db.prepare("DELETE FROM doc_entities WHERE doc_id = ?");
    for (const r of rows) {
      delDoc.run(r.id);
      delFts.run(r.id);
      delEnt.run(r.id);
    }
    return rows.length;
  }

  /**
   * Re-applies all supersedes pointers across the database after batch updates.
   */
  recomputeSupersedes(): void {
    this.db.exec("UPDATE docs SET superseded_by = NULL");
    const rows = this.db
      .prepare("SELECT id, supersedes_json FROM docs WHERE supersedes_json != '[]'")
      .all() as Array<{ id: string; supersedes_json: string }>;
    const mark = this.db.prepare("UPDATE docs SET superseded_by = ? WHERE id = ?");
    for (const row of rows) {
      try {
        const list = JSON.parse(row.supersedes_json) as string[];
        for (const target of list) {
          mark.run(row.id, target);
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Incremental sync for specific files changed by `git pull` or local edits.
   */
  syncFiles(store: GitMemoryStore, relPaths: string[]): { indexed: number; removed: number } {
    let indexed = 0;
    let removed = 0;
    for (const rel of relPaths) {
      if (!rel.endsWith(".md") && !rel.endsWith(".jsonl")) continue;
      if (!rel.startsWith("global/") && !rel.startsWith("banks/")) continue;
      const docs = store.parseFile(rel);
      if (docs.length === 0) {
        removed += this.removeByFilePath(rel);
      } else {
        this.removeByFilePath(rel);
        for (const doc of docs) {
          this.upsertDocument(doc);
          indexed++;
        }
      }
    }
    if (indexed > 0 || removed > 0) {
      this.recomputeSupersedes();
    }
    return { indexed, removed };
  }

  /**
   * Full rebuild of local SQLite index from Git-tracked plaintext files.
   */
  fullReindex(store: GitMemoryStore): { indexed: number; removed: number } {
    const files = store.listAllMemoryFiles();
    const diskSet = new Set(files);
    const indexedRows = this.db
      .prepare("SELECT DISTINCT file_path FROM docs")
      .all() as Array<{ file_path: string }>;

    let removed = 0;
    for (const row of indexedRows) {
      if (!diskSet.has(row.file_path)) {
        removed += this.removeByFilePath(row.file_path);
      }
    }

    let indexed = 0;
    for (const rel of files) {
      const docs = store.parseFile(rel);
      for (const doc of docs) {
        this.upsertDocument(doc);
        indexed++;
      }
    }
    this.recomputeSupersedes();
    return { indexed, removed };
  }

  /**
   * 4-way Hindsight-inspired parallel recall:
   *  1) BM25 (FTS5 over CJK-bigram + code-identifier tokens)
   *  2) Optional semantic vector similarity
   *  3) Entity graph 1-hop expansion
   *  4) Authority + recency + supersede reranking
   */
  recall(opts: {
    query: string;
    bankIds: string[];
    kinds?: MemoryKind[];
    limit?: number;
    includeSuperseded?: boolean;
    queryEmbedding?: number[] | null;
  }): RecallResult[] {
    const limit = opts.limit ?? 10;
    const bankPlaceholders = opts.bankIds.map(() => "?").join(",");
    if (!bankPlaceholders) return [];

    // 1. BM25 candidates via FTS5
    const bm25Scores = new Map<string, number>();
    const ftsQuery = buildFtsQuery(opts.query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT doc_id, bm25(docs_fts, 3.0, 1.0, 2.0) AS rank
             FROM docs_fts
             WHERE bank_id IN (${bankPlaceholders}) AND docs_fts MATCH ?
             ORDER BY rank
             LIMIT 60`
          )
          .all(...opts.bankIds, ftsQuery) as Array<{ doc_id: string; rank: number }>;

        for (const r of rows) {
          // SQLite bm25 returns negative values (more negative = better match)
          const normalized = 1 / (1 + Math.exp(r.rank * 0.35));
          bm25Scores.set(r.doc_id, normalized);
        }
      } catch {
        // Malformed FTS syntax fallback handled below
      }
    }

    // 2. Entity graph 1-hop candidates
    const graphScores = new Map<string, number>();
    const queryEntities = new Set<string>(extractEntities(opts.query, 12));
    for (const token of opts.query.toLowerCase().split(/[\s,.;:/\\()[\]{}"'`]+/)) {
      if (token.length >= 2) queryEntities.add(token);
    }

    if (queryEntities.size > 0) {
      const entList = [...queryEntities].slice(0, 16);
      const entPh = entList.map(() => "?").join(",");
      const directHits = this.db
        .prepare(
          `SELECT doc_id, COUNT(DISTINCT entity) AS hits
           FROM doc_entities
           WHERE bank_id IN (${bankPlaceholders}) AND entity IN (${entPh})
           GROUP BY doc_id
           LIMIT 40`
        )
        .all(...opts.bankIds, ...entList) as Array<{ doc_id: string; hits: number }>;

      for (const h of directHits) {
        graphScores.set(h.doc_id, Math.min(1, h.hits * 0.45));
      }

      // 1-hop neighbor expansion via shared entities from top BM25 hits
      const seedIds = [...bm25Scores.keys()].slice(0, 5);
      if (seedIds.length > 0) {
        const seedPh = seedIds.map(() => "?").join(",");
        const neighbors = this.db
          .prepare(
            `SELECT e2.doc_id, COUNT(DISTINCT e2.entity) AS shared
             FROM doc_entities e1
             JOIN doc_entities e2 ON e1.entity = e2.entity AND e1.bank_id = e2.bank_id
             WHERE e1.doc_id IN (${seedPh}) AND e2.doc_id NOT IN (${seedPh})
             GROUP BY e2.doc_id
             ORDER BY shared DESC
             LIMIT 20`
          )
          .all(...seedIds, ...seedIds) as Array<{ doc_id: string; shared: number }>;

        for (const n of neighbors) {
          const prev = graphScores.get(n.doc_id) ?? 0;
          graphScores.set(n.doc_id, Math.min(1, prev + n.shared * 0.2));
        }
      }
    }

    // 3. Vector similarity candidates (when query embedding is provided)
    const vecScores = new Map<string, number>();
    if (opts.queryEmbedding && opts.queryEmbedding.length > 0) {
      const vecRows = this.db
        .prepare(
          `SELECT id, embedding_json FROM docs
           WHERE bank_id IN (${bankPlaceholders}) AND embedding_json IS NOT NULL`
        )
        .all(...opts.bankIds) as Array<{ id: string; embedding_json: string }>;

      for (const r of vecRows) {
        try {
          const vec = JSON.parse(r.embedding_json) as number[];
          const sim = cosineSimilarity(opts.queryEmbedding, vec);
          if (sim > 0.2) vecScores.set(r.id, sim);
        } catch {
          // ignore
        }
      }
    }

    // Combine candidate pool; if empty (e.g., broad query), pull recent high-authority docs
    const candidateIds = new Set<string>([
      ...bm25Scores.keys(),
      ...graphScores.keys(),
      ...vecScores.keys()
    ]);

    let rows: DocRow[] = [];
    if (candidateIds.size > 0) {
      const idList = [...candidateIds];
      const idPh = idList.map(() => "?").join(",");
      rows = this.db
        .prepare(`SELECT * FROM docs WHERE id IN (${idPh})`)
        .all(...idList) as unknown as DocRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM docs
           WHERE bank_id IN (${bankPlaceholders})
           ORDER BY updated_at DESC
           LIMIT 30`
        )
        .all(...opts.bankIds) as unknown as DocRow[];
    }

    const nowMs = Date.now();
    const results: RecallResult[] = [];
    const kindFilter = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;

    for (const row of rows) {
      if (kindFilter && !kindFilter.has(row.kind)) continue;
      if (!opts.includeSuperseded && row.superseded_by) continue;

      const bm25 = bm25Scores.get(row.id) ?? 0;
      const vector = vecScores.get(row.id) ?? 0;
      const graph = graphScores.get(row.id) ?? 0;
      const authority = (KIND_AUTHORITY[row.kind] ?? 1.0) * Math.max(0.2, row.confidence);

      const ageDays = Math.max(0, (nowMs - Date.parse(row.updated_at || row.created_at)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 45); // Gentle 45-day half-decay

      const hasVector = Boolean(opts.queryEmbedding && opts.queryEmbedding.length > 0);
      const relevance = hasVector
        ? bm25 * 0.45 + vector * 0.35 + graph * 0.2
        : bm25 * 0.72 + graph * 0.28;

      const supersedePenalty = row.superseded_by ? 0.25 : 1.0;
      const finalScore = (relevance + 0.12 * recency) * authority * supersedePenalty;

      results.push({
        id: row.id,
        bankId: row.bank_id,
        kind: row.kind,
        title: row.title,
        snippet: makeSnippet(row.content, opts.query),
        content: row.content,
        score: Number(finalScore.toFixed(4)),
        scoreBreakdown: {
          bm25: Number(bm25.toFixed(3)),
          vector: Number(vector.toFixed(3)),
          graph: Number(graph.toFixed(3)),
          authority: Number(authority.toFixed(3)),
          recency: Number(recency.toFixed(3))
        },
        entities: safeJsonArray(row.entities_json),
        tags: safeJsonArray(row.tags_json),
        harness: row.harness,
        updatedAt: row.updated_at,
        filePath: row.file_path,
        supersededBy: row.superseded_by
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  listPages(bankIds: string[]): MemoryDocument[] {
    if (bankIds.length === 0) return [];
    const ph = bankIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM docs
         WHERE bank_id IN (${ph}) AND kind IN ('page', 'initiative')
         ORDER BY kind ASC, updated_at DESC`
      )
      .all(...bankIds) as unknown as DocRow[];
    return rows.map(rowToDoc);
  }

  getDocByIdOrSlug(bankIds: string[], idOrSlug: string): MemoryDocument | null {
    if (bankIds.length === 0) return null;
    const ph = bankIds.map(() => "?").join(",");
    const exact = this.db
      .prepare(`SELECT * FROM docs WHERE bank_id IN (${ph}) AND id = ? LIMIT 1`)
      .get(...bankIds, idOrSlug) as unknown as DocRow | undefined;
    if (exact) return rowToDoc(exact);

    const byPath = this.db
      .prepare(
        `SELECT * FROM docs
         WHERE bank_id IN (${ph})
           AND (lower(title) = lower(?) OR file_path LIKE ?)
         LIMIT 1`
      )
      .get(...bankIds, idOrSlug, `%/${idOrSlug}.md`) as unknown as DocRow | undefined;
    return byPath ? rowToDoc(byPath) : null;
  }

  getTotalCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM docs").get() as { cnt: number };
    return row.cnt;
  }

  getBankStats(bankId: string): {
    bankId: string;
    pages: number;
    initiatives: number;
    observations: number;
    corrections: number;
    episodes: number;
  } {
    const rows = this.db
      .prepare("SELECT kind, COUNT(*) AS cnt FROM docs WHERE bank_id = ? GROUP BY kind")
      .all(bankId) as Array<{ kind: MemoryKind; cnt: number }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.kind] = r.cnt;
    return {
      bankId,
      pages: counts.page ?? 0,
      initiatives: counts.initiative ?? 0,
      observations: counts.observation ?? 0,
      corrections: counts.correction ?? 0,
      episodes: (counts.world ?? 0) + (counts.experience ?? 0)
    };
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToDoc(row: DocRow): MemoryDocument {
  return {
    id: row.id,
    bankId: row.bank_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    entities: safeJsonArray(row.entities_json),
    tags: safeJsonArray(row.tags_json),
    harness: row.harness,
    source: row.source ?? undefined,
    confidence: row.confidence,
    supersedes: safeJsonArray(row.supersedes_json),
    supersededBy: row.superseded_by,
    evidenceIds: safeJsonArray(row.evidence_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    filePath: row.file_path,
    contentHash: row.content_hash
  };
}

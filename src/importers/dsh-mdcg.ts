import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { sanitizeSlug } from "../core/bank.js";
import { KeystoneEngine } from "../core/engine.js";
import { parseFrontmatter } from "../core/markdown.js";

export interface DshImportReport {
  sourceDir: string;
  scanned: number;
  importedPages: number;
  importedInitiatives: number;
  importedObservations: number;
  importedEpisodes: number;
  filteredNoise: number;
  skipped: number;
  errors: string[];
}

function isZeroSignalNoise(body: string): boolean {
  const clean = body.trim();
  if (!clean) return true;
  // Automated dsh desktop pet heartbeats/touch pings
  if (/\[启动问好\]|\[世界时钟\]|\[被触摸\]|\bpet_say\b|\bpet_do\b/.test(clean)) {
    return true;
  }
  // Bare session UUID with no surrounding context
  if (/^session-[0-9a-f-]{20,}$/i.test(clean)) {
    return true;
  }
  // Tiny 1-10 char filler ticks lacking technical keywords
  if (
    clean.length <= 10 &&
    !/(4gb|云|ip|api|ui|bug|人机|git|docker|redis|ssot|mcp|ssh)/i.test(clean)
  ) {
    return true;
  }
  return false;
}

const SKIP_DIRS = new Set([
  "trash",
  "rejected",
  "_node_locks",
  "_protected_history",
  "_index_log"
]);

function extractTitle(body: string, fallbackId: string): string {
  const funcMatch = body.match(/^#\s*功能[：:]\s*(.+)$/m);
  if (funcMatch?.[1]) return funcMatch[1].trim();
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match?.[1]) return h1Match[1].trim();
  const bracketMatch = body.match(/^【([^】]+)】/m);
  if (bracketMatch?.[1]) return bracketMatch[1].trim();
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#"));
  if (firstLine) return firstLine.slice(0, 72);
  return fallbackId;
}

/**
 * Losslessly migrates an existing `.dsh/.dsh-memory` (MDCG) memory store into Keystone.
 * Maps:
 *  - anchor / self / structural / knowledge -> global Mental Model Pages (`global/pages/`)
 *  - goals -> global Initiatives (`global/pages/initiatives/`)
 *  - contextual / hippocampus / unresolved -> global Observations or Episodes
 * Skips trash/, rejected/, _node_locks/, and _protected_history/.
 */
export async function importDshMdcg(
  engine: KeystoneEngine,
  dshMemoryDir: string,
  opts: { bankId?: string; commit?: boolean; filterNoise?: boolean } = {}
): Promise<DshImportReport> {
  const mdcgDir = existsSync(join(dshMemoryDir, "data", "mdcg"))
    ? join(dshMemoryDir, "data", "mdcg")
    : dshMemoryDir;

  const report: DshImportReport = {
    sourceDir: mdcgDir,
    scanned: 0,
    importedPages: 0,
    importedInitiatives: 0,
    importedObservations: 0,
    importedEpisodes: 0,
    filteredNoise: 0,
    skipped: 0,
    errors: []
  };

  if (!existsSync(mdcgDir)) {
    report.errors.push(`Directory not found: ${mdcgDir}`);
    return report;
  }

  const targetBank = opts.bankId || engine.config.globalBankId;
  const mdFiles: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("_")) {
        mdFiles.push(join(dir, entry.name));
      }
    }
  };
  walk(mdcgDir);

  // Deduplicate contextual memories already migrated in a prior run
  const existingSourceTags = new Set<string>();
  for (const rel of engine.store.listAllMemoryFiles()) {
    for (const doc of engine.store.parseFile(rel)) {
      for (const t of doc.tags) {
        if (t.startsWith("mdcg_id:")) existingSourceTags.add(t);
      }
    }
  }

  for (const absPath of mdFiles.sort()) {
    report.scanned++;
    try {
      if (statSync(absPath).size === 0) {
        report.skipped++;
        continue;
      }

      const relParts = relative(mdcgDir, absPath).split(sep);
      const topLayer = relParts[0] || "contextual";
      const raw = readFileSync(absPath, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const cleanBody = body.trim();
      if (!cleanBody) {
        report.skipped++;
        continue;
      }

      const rawId =
        typeof meta.id === "string" && meta.id
          ? meta.id
          : basename(absPath, ".md");
      const mdcgTag = `mdcg_id:${rawId}`;

      const rawTags = Array.isArray(meta.tags) ? meta.tags.map(String) : [];
      const tags = [
        ...new Set([
          ...rawTags,
          `mdcg_layer:${topLayer}`,
          mdcgTag,
          "migrated:dsh-mdcg"
        ])
      ];
      const title = extractTitle(cleanBody, rawId);
      const slug = sanitizeSlug(rawId);

      // 1. High-authority structured layers -> Mental Model Pages (idempotent upsert by slug)
      if (
        topLayer === "anchor" ||
        topLayer === "self" ||
        topLayer === "structural" ||
        topLayer === "knowledge"
      ) {
        const subFolder = relParts.length > 2 ? relParts[1] : null;
        if (subFolder) tags.push(`mdcg_cluster:${subFolder}`);

        await engine.upsertPage({
          bankId: targetBank,
          slug,
          title,
          content: cleanBody,
          harness: "dsh",
          tags,
          syncMode: "none"
        });
        report.importedPages++;
        continue;
      }

      // 2. Goals -> Living Initiatives (idempotent upsert by slug)
      if (topLayer === "goals") {
        await engine.captureInitiative({
          bankId: targetBank,
          slug,
          title,
          summary: cleanBody,
          harness: "dsh",
          tags,
          syncMode: "none"
        });
        report.importedInitiatives++;
        continue;
      }

      // 3. Contextual / Hippocampus / Unresolved -> Observations or Episodes (skip if already migrated)
      if (opts.filterNoise !== false && isZeroSignalNoise(cleanBody)) {
        report.filteredNoise++;
        continue;
      }
      if (existingSourceTags.has(mdcgTag)) {
        report.skipped++;
        continue;
      }

      const importance = typeof meta.importance === "number" ? meta.importance : 0.5;
      const confidence = typeof meta.confidence === "number" ? Math.max(0.5, meta.confidence) : 0.8;
      const isObservation = importance >= 0.65 || cleanBody.length > 1500 || topLayer === "unresolved";

      await engine.retain({
        bankId: targetBank,
        kind: isObservation ? "observation" : "experience",
        title,
        content: cleanBody,
        harness: "dsh",
        tags,
        confidence,
        source: `dsh-mdcg:${relParts.join("/")}`,
        syncMode: "none"
      });
      if (isObservation) {
        report.importedObservations++;
      } else {
        report.importedEpisodes++;
      }
    } catch (err: unknown) {
      report.errors.push(`${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  engine.index.recomputeSupersedes();

  if (opts.commit !== false) {
    const total =
      report.importedPages +
      report.importedInitiatives +
      report.importedObservations +
      report.importedEpisodes;
    if (total > 0) {
      engine.sync.commitAndPush(
        `mem(${targetBank}): migrate ${total} memories from dsh-mdcg (${report.importedPages} pages, ${report.importedInitiatives} initiatives, ${report.importedObservations} obs, ${report.importedEpisodes} episodes)`,
        { push: engine.config.git.autoPush && Boolean(engine.sync.getRemoteUrl()) }
      );
    }
  }

  return report;
}

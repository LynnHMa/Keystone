import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { sanitizeSlug } from "../core/bank.js";
import { KeystoneEngine } from "../core/engine.js";
import { parseFrontmatter } from "../core/markdown.js";

export interface CodexImportReport {
  sourceDirs: string[];
  scanned: number;
  importedPages: number;
  skipped: number;
  errors: string[];
}

const SKIP_DIRS = new Set([".git", ".codex-baseline", "node_modules"]);
const SKIP_FILES = new Set(["raw_memories.md", "instructions.md", "MEMORY.md", "memory_summary.md"]);

function extractTitle(body: string, metaName: unknown, fallback: string): string {
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1) return h1;
  if (typeof metaName === "string" && metaName.trim()) return metaName.trim();
  return fallback;
}

/**
 * Imports Markdown memories from ~/.codex/memories and/or Arch distillation folders
 * into Keystone's curated Mental Model Pages (`global/pages/`), prefixed cleanly so
 * they complement dsh-mdcg memories without overwriting newer entries.
 */
export async function importCodexMemories(
  engine: KeystoneEngine,
  sourceDirs: string[],
  opts: { bankId?: string; commit?: boolean } = {}
): Promise<CodexImportReport> {
  const targetBank = opts.bankId || engine.config.globalBankId;
  const report: CodexImportReport = {
    sourceDirs,
    scanned: 0,
    importedPages: 0,
    skipped: 0,
    errors: []
  };

  for (const rootDir of sourceDirs) {
    if (!existsSync(rootDir)) {
      report.errors.push(`Directory not found: ${rootDir}`);
      continue;
    }

    const isDistillation = rootDir.toLowerCase().includes("arch-distillation");
    const prefix = isDistillation ? "arch_origin_" : "codex_";
    const files: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          // Skip giant raw transcripts (>200KB) during structured page import
          if (isDistillation && !/^0\d_/.test(entry.name)) continue;
          if (!isDistillation && SKIP_FILES.has(entry.name)) continue;
          files.push(join(dir, entry.name));
        }
      }
    };
    walk(rootDir);

    for (const absPath of files.sort()) {
      report.scanned++;
      try {
        const size = statSync(absPath).size;
        if (size < 60 || size > 200_000) {
          report.skipped++;
          continue;
        }
        const raw = readFileSync(absPath, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const cleanBody = body.trim();
        if (!cleanBody) {
          report.skipped++;
          continue;
        }

        const rel = relative(rootDir, absPath).split(sep).join("/");
        const baseSlug = basename(absPath, ".md") === "SKILL"
          ? `skill_${rel.split("/").slice(-2, -1)[0] || "custom"}`
          : basename(absPath, ".md");
        const slug = sanitizeSlug(`${prefix}${baseSlug}`);
        const title = extractTitle(cleanBody, meta.name, baseSlug);

        const tags = [
          isDistillation ? "migrated:distillation" : "migrated:codex-memories",
          `source_rel:${rel}`
        ];
        if (rel.toLowerCase().includes("persona") || rel.toLowerCase().includes("identity")) {
          tags.push("persona", "identity");
        }

        await engine.upsertPage({
          bankId: targetBank,
          slug,
          title,
          content: cleanBody,
          harness: "codex",
          tags,
          syncMode: "none"
        });
        report.importedPages++;
      } catch (err: unknown) {
        report.errors.push(`${absPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  engine.index.recomputeSupersedes();

  if (opts.commit !== false && report.importedPages > 0) {
    engine.sync.commitAndPush(
      `mem(${targetBank}): merge ${report.importedPages} pages from codex-memories & arch-distillation`,
      { push: engine.config.git.autoPush && Boolean(engine.sync.getRemoteUrl()) }
    );
  }

  return report;
}

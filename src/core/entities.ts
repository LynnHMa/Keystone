/**
 * Deterministic entity & CJK-aware tokenization utilities.
 * Ensures Chinese + English + code symbols work seamlessly in SQLite FTS5 with zero native plugins.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "been", "were",
  "will", "would", "could", "should", "into", "about", "there", "their", "which",
  "when", "where", "what", "while", "using", "used", "make", "made", "file", "code",
  "true", "false", "null", "undefined", "const", "return", "function", "import", "export"
]);

/**
 * Expands CJK runs into overlapping bigrams + unigrams so SQLite FTS5 unicode61
 * achieves accurate Chinese/Japanese/Korean BM25 matching without external tokenizers.
 */
export function buildSearchTokens(text: string): string {
  if (!text) return "";
  const tokens: string[] = [];

  // Keep ASCII identifiers/paths intact + split camelCase/snake_case
  const asciiMatches = text.match(/[A-Za-z0-9_./:-]{2,}/g) ?? [];
  for (const raw of asciiMatches) {
    const lower = raw.toLowerCase();
    tokens.push(lower);
    const parts = raw
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[_\-./:]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2);
    if (parts.length > 1) {
      tokens.push(...parts);
    }
  }

  // Expand CJK character runs into overlapping 2-grams (and single chars for 1-char runs)
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
      if (run.length <= 6) {
        tokens.push(run);
      }
    }
  }

  return tokens.join(" ");
}

/**
 * Extracts entities (file paths, code symbols, backtick terms, @packages, CJK key terms)
 * for entity-graph indexing and 1-2 hop recall expansion.
 */
export function extractEntities(text: string, maxEntities = 24): string[] {
  const found = new Map<string, number>();

  const bump = (raw: string, weight = 1) => {
    const clean = raw.trim().replace(/^['"`(\[{]+|['"`)\]}.,;:!?]+$/g, "");
    if (clean.length < 2 || clean.length > 80) return;
    const key = clean.toLowerCase();
    if (STOPWORDS.has(key)) return;
    found.set(key, (found.get(key) ?? 0) + weight);
  };

  // 1. Backtick code spans (highest signal)
  for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
    bump(m[1], 4);
  }

  // 2. File paths (e.g. src/core/engine.ts, package.json)
  for (const m of text.matchAll(/\b(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]{1,8}\b|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml|sql|sh)\b/g)) {
    bump(m[0], 3);
  }

  // 3. Scoped packages & handles (@scope/pkg)
  for (const m of text.matchAll(/@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/g)) {
    bump(m[0], 3);
  }

  // 4. CamelCase / PascalCase / snake_case identifiers
  for (const m of text.matchAll(/\b(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z]+_[a-z0-9_]+|[A-Z]{2,}_[A-Z0-9_]+)\b/g)) {
    bump(m[0], 2);
  }

  // 5. Quoted/Bracketed Chinese concepts (e.g. 「...」 《...》)
  for (const m of text.matchAll(/[「《【]([^」》】\n]{2,20})[」》】]/g)) {
    bump(m[1], 3);
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntities)
    .map(([k]) => k);
}

export type FrontmatterValue = string | number | boolean | null | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

function escapeYamlString(value: string): string {
  if (
    value === "" ||
    /[:#\[\]{}&*!|>'"%@`,?]/.test(value) ||
    /^\s|\s$/.test(value) ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    /^-?\d+(\.\d+)?$/.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

export function serializeFrontmatter(meta: Frontmatter, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, val] of Object.entries(meta)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) {
          lines.push(`  - ${escapeYamlString(String(item))}`);
        }
      }
    } else if (val === null) {
      lines.push(`${key}: null`);
    } else if (typeof val === "number" || typeof val === "boolean") {
      lines.push(`${key}: ${String(val)}`);
    } else {
      lines.push(`${key}: ${escapeYamlString(String(val))}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n") + body.trimEnd() + "\n";
}

function parseScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~" || trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed);
      return trimmed.slice(1, -1).replace(/''/g, "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized };
  }
  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    return { meta: {}, body: normalized };
  }

  const header = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).replace(/^\n+/, "");
  const meta: Frontmatter = {};

  let currentArrayKey: string | null = null;
  for (const line of header.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (currentArrayKey && /^\s+-\s+/.test(line)) {
      const itemRaw = line.replace(/^\s+-\s+/, "");
      const arr = meta[currentArrayKey] as string[];
      const parsed = parseScalar(itemRaw);
      if (parsed !== null) arr.push(String(parsed));
      continue;
    }

    currentArrayKey = null;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === "") {
      meta[key] = [];
      currentArrayKey = key;
    } else if (rest === "[]") {
      meta[key] = [];
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      try {
        const parsed = JSON.parse(rest);
        meta[key] = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
      } catch {
        meta[key] = rest
          .slice(1, -1)
          .split(",")
          .map((s) => String(parseScalar(s) ?? ""))
          .filter(Boolean);
      }
    } else {
      meta[key] = parseScalar(rest);
    }
  }

  return { meta, body };
}

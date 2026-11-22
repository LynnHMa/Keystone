import { existsSync, readFileSync } from "node:fs";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string; content?: string };
        if ((b.type === "text" || b.type === "input_text" || b.type === "output_text") && b.text) {
          parts.push(b.text);
        } else if (typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function stripAntigravityWrapper(raw: string): string {
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (match ? match[1] : raw).trim();
}

export function formatTurns(turns: Turn[], maxChars = 8000): string {
  const cleaned = turns
    .map((t) => ({ role: t.role, text: t.text.trim() }))
    .filter((t) => t.text.length > 0);
  if (cleaned.length === 0) return "";
  const lines = cleaned.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
  const joined = lines.join("\n\n");
  return joined.length <= maxChars ? joined : joined.slice(-maxChars);
}

/**
 * Reads Antigravity's transcript.jsonl format (`USER_INPUT` / `PLANNER_RESPONSE`).
 */
export function readAntigravityTranscript(transcriptPath?: string): { turns: Turn[]; trailingUserPrompt: string | null } {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { turns: [], trailingUserPrompt: null };
  }
  const turns: Turn[] = [];
  let lastType = "";
  let trailingUserPrompt: string | null = null;

  try {
    const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { type?: string; content?: unknown };
        if (row.type) lastType = row.type;
        if (row.type === "USER_INPUT") {
          const text = stripAntigravityWrapper(extractContentText(row.content));
          if (text) {
            turns.push({ role: "user", text });
            trailingUserPrompt = text;
          }
        } else if (row.type === "PLANNER_RESPONSE") {
          const text = extractContentText(row.content);
          if (text) turns.push({ role: "assistant", text });
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    return { turns: [], trailingUserPrompt: null };
  }

  // Only treat as a genuine user prompt submission if the last recorded event was USER_INPUT
  if (lastType !== "USER_INPUT") {
    trailingUserPrompt = null;
  }
  return { turns, trailingUserPrompt };
}

/**
 * Reads Claude Code / Codex JSONL session transcripts.
 */
export function readClaudeOrCodexTranscript(transcriptPath?: string, lastAssistantMessage?: string): Turn[] {
  const turns: Turn[] = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          // Claude Code format: { type: "user"|"assistant", message: { role, content } }
          const msg = (obj.message as { role?: string; content?: unknown } | undefined) ??
            (obj.payload as { role?: string; content?: unknown } | undefined) ??
            (obj as { role?: string; content?: unknown });
          const role = msg?.role ?? (obj.type === "user" || obj.type === "assistant" ? String(obj.type) : undefined);
          if (role === "user" || role === "assistant") {
            const text = extractContentText(msg?.content);
            if (text.trim()) turns.push({ role, text: text.trim() });
          }
        } catch {
          // skip
        }
      }
    } catch {
      // ignore
    }
  }

  if (lastAssistantMessage && lastAssistantMessage.trim()) {
    const last = turns.at(-1);
    if (!last || last.role !== "assistant" || last.text !== lastAssistantMessage.trim()) {
      turns.push({ role: "assistant", text: lastAssistantMessage.trim() });
    }
  }
  return turns;
}

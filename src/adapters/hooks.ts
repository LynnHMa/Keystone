import { readFileSync } from "node:fs";
import { KeystoneEngine } from "../core/engine.js";
import type { HarnessName } from "../core/types.js";
import {
  formatTurns,
  readAntigravityTranscript,
  readClaudeOrCodexTranscript
} from "./transcripts.js";

function readStdinJson(): Record<string, unknown> | null {
  try {
    const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function resolveCwdFromEvent(harness: HarnessName, ev: Record<string, unknown>): string | undefined {
  if (harness === "antigravity-cli") {
    const paths = ev.workspacePaths;
    if (Array.isArray(paths) && typeof paths[0] === "string") return paths[0];
  }
  if (typeof ev.cwd === "string" && ev.cwd) return ev.cwd;
  return process.cwd();
}

/**
 * Unified hook entrypoint invoked by Claude Code, Codex CLI, and Antigravity CLI:
 *   node dist/cli/index.js hook <claude-code|codex|antigravity-cli> <session-start|prompt|stop>
 */
export async function runHookCommand(
  harness: "claude-code" | "codex" | "antigravity-cli",
  event: "session-start" | "prompt" | "stop"
): Promise<void> {
  const ev = readStdinJson() ?? {};
  const engine = new KeystoneEngine();

  try {
    const cwd = resolveCwdFromEvent(harness, ev);

    if (event === "session-start") {
      const bank = engine.resolveBankForCwd(cwd);
      const status = engine.syncStatus(cwd);
      const notice = status.remoteAhead
        ? `🧠 Keystone (${bank.bankId}) — remote ahead, run \`keystone pull\``
        : `🧠 Keystone memory active (${bank.bankId}, ${status.totalIndexedDocs} memories)`;

      if (harness === "antigravity-cli") {
        writeJson({});
      } else {
        writeJson({
          systemMessage: notice,
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: notice
          }
        });
      }
      return;
    }

    if (event === "prompt") {
      let promptText = "";
      if (harness === "antigravity-cli") {
        const transcriptPath = typeof ev.transcriptPath === "string" ? ev.transcriptPath : undefined;
        const parsed = readAntigravityTranscript(transcriptPath);
        promptText = parsed.trailingUserPrompt ?? "";
      } else {
        promptText = typeof ev.prompt === "string" ? ev.prompt : "";
      }

      if (!promptText.trim()) {
        writeJson(harness === "antigravity-cli" ? { injectSteps: [] } : {});
        return;
      }

      const sessionId = String(ev.conversationId ?? ev.session_id ?? "");
      const context = await engine.buildContextInjection({
        cwd,
        prompt: promptText,
        harness,
        sessionId: sessionId || undefined
      });

      if (!context) {
        writeJson(harness === "antigravity-cli" ? { injectSteps: [] } : {});
        return;
      }

      if (harness === "antigravity-cli") {
        writeJson({ injectSteps: [{ ephemeralMessage: context }] });
      } else {
        writeJson({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: context
          }
        });
      }
      return;
    }

    if (event === "stop") {
      const sessionId = String(ev.conversationId ?? ev.session_id ?? `sess_${Date.now()}`);
      let summary = "";

      if (harness === "antigravity-cli") {
        const transcriptPath = typeof ev.transcriptPath === "string" ? ev.transcriptPath : undefined;
        const parsed = readAntigravityTranscript(transcriptPath);
        summary = formatTurns(parsed.turns.slice(-10));
      } else {
        const transcriptPath = typeof ev.transcript_path === "string" ? ev.transcript_path : undefined;
        const lastMsg = typeof ev.last_assistant_message === "string" ? ev.last_assistant_message : undefined;
        const turns = readClaudeOrCodexTranscript(transcriptPath, lastMsg);
        summary = formatTurns(turns.slice(-10));
      }

      if (summary.length >= 40) {
        await engine.retainSessionTranscript({
          cwd,
          harness,
          sessionId,
          transcriptSummary: summary,
          syncMode: "background"
        });
      }
      writeJson({});
    }
  } catch {
    // Hooks must never crash the host coding agent
    writeJson(harness === "antigravity-cli" && event === "prompt" ? { injectSteps: [] } : {});
  } finally {
    engine.close();
  }
}

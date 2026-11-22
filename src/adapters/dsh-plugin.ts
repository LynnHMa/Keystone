/**
 * Native Cordis Plugin for DeepSeek Harness (dsh).
 * Registered via ~/.dsh/cordis.patch.yml:
 *   - insert:
 *       - id: keystone
 *         name: "file:///.../dist/adapters/dsh-plugin.js"
 */
import { KeystoneEngine } from "../core/engine.js";
import type { MemoryKind } from "../core/types.js";
import { formatTurns, type Turn } from "./transcripts.js";

export const name = "keystone";
export const inject = { optional: ["tools"] };

interface DshMessage {
  role?: string;
  content?: unknown;
}

interface DshAgent {
  cwd?: string;
  workspace?: string;
  session?: {
    header?: { id?: string; cwd?: string };
    events?: Array<{ type?: string; role?: string; content?: unknown; message?: DshMessage }>;
  };
}

interface DshPreStepDecision {
  kind?: string;
  messages?: DshMessage[];
}

interface DshToolContext {
  tools: {
    register: (spec: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, { type: "string"; description?: string }>;
        required?: string[];
      };
      output: {
        schema: { type: "string" };
        render: (_args: unknown, value: string) => Array<{ type: "text"; text: string }>;
      };
      execute: (args: Record<string, string>, exec?: { agent?: DshAgent }) => Promise<string>;
    }) => void;
  };
}

interface CordisContext {
  on: (event: string, listener: (...args: any[]) => any, opts?: { prepend?: boolean }) => void;
  inject: (deps: string[], callback: (ctx: DshToolContext) => void) => void;
}

function agentCwd(agent?: DshAgent): string {
  return agent?.cwd || agent?.workspace || agent?.session?.header?.cwd || process.cwd();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function lastUserPrompt(messages?: DshMessage[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      const t = extractText(messages[i].content).trim();
      if (t && !t.startsWith("🧠 Keystone")) return t;
    }
  }
  return "";
}

function extractSessionTurns(agent?: DshAgent): Turn[] {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return [];
  const turns: Turn[] = [];
  for (const ev of events) {
    const role = ev.message?.role ?? ev.role;
    const text = extractText(ev.message?.content ?? ev.content).trim();
    if ((role === "user" || role === "assistant") && text && !text.startsWith("🧠 Keystone")) {
      turns.push({ role, text });
    }
  }
  return turns;
}

export function apply(ctx: CordisContext): void {
  const injectedSessions = new Set<string>();

  const withEngine = async <T>(fn: (engine: KeystoneEngine) => Promise<T>): Promise<T> => {
    const engine = new KeystoneEngine();
    try {
      return await fn(engine);
    } finally {
      engine.close();
    }
  };

  ctx.on("agent/session-start", async ({ agent }: { agent?: DshAgent }) => {
    const id = agent?.session?.header?.id;
    if (id) injectedSessions.delete(id);
  });

  ctx.on(
    "agent/pre-step",
    async ({ agent, decision }: { agent?: DshAgent; decision?: DshPreStepDecision }) => {
      if (!decision || !Array.isArray(decision.messages)) return decision;
      const sessionId = agent?.session?.header?.id ?? "default";
      if (injectedSessions.has(sessionId)) return decision;

      const prompt = lastUserPrompt(decision.messages);
      if (!prompt) return decision;

      const injection = await withEngine((engine) =>
        engine.buildContextInjection({
          cwd: agentCwd(agent),
          prompt,
          harness: "dsh"
        })
      );
      if (!injection) return decision;

      injectedSessions.add(sessionId);
      return {
        kind: "enter",
        messages: [...decision.messages, { role: "system", content: injection }]
      };
    },
    { prepend: true }
  );

  ctx.on("agent/turn-stopping", async ({ agent }: { agent?: DshAgent }) => {
    const sessionId = agent?.session?.header?.id ?? `dsh_${Date.now()}`;
    const turns = extractSessionTurns(agent).slice(-10);
    const summary = formatTurns(turns);
    if (summary.length < 40) return;

    await withEngine((engine) =>
      engine.retainSessionTranscript({
        cwd: agentCwd(agent),
        harness: "dsh",
        sessionId,
        transcriptSummary: summary,
        syncMode: "background"
      })
    );
  });

  ctx.on("agent/disposed", ({ agent }: { agent?: DshAgent }) => {
    const id = agent?.session?.header?.id;
    if (id) injectedSessions.delete(id);
  });

  ctx.inject(["tools"], (toolCtx) => {
    const render = (_args: unknown, value: string) => [{ type: "text" as const, text: value }];

    toolCtx.tools.register({
      name: "keystone_recall",
      description: "Hybrid recall across Keystone shared memory (BM25 + Graph + Authority).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          bank_id: { type: "string", description: "Optional explicit bank id (e.g. global)" }
        },
        required: ["query"]
      },
      output: { schema: { type: "string" }, render },
      execute: (args, exec) =>
        withEngine(async (engine) => {
          const out = await engine.recall({
            query: args.query,
            cwd: agentCwd(exec?.agent),
            bankId: args.bank_id
          });
          return JSON.stringify(out, null, 2);
        })
    });

    toolCtx.tools.register({
      name: "keystone_reflect",
      description: "Synthesize an evidence-backed reflection over Keystone memories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Question to reflect on" },
          bank_id: { type: "string", description: "Optional explicit bank id" }
        },
        required: ["query"]
      },
      output: { schema: { type: "string" }, render },
      execute: (args, exec) =>
        withEngine(async (engine) => {
          const out = await engine.reflect({
            query: args.query,
            cwd: agentCwd(exec?.agent),
            bankId: args.bank_id
          });
          return out.synthesis;
        })
    });

    toolCtx.tools.register({
      name: "keystone_retain",
      description: "Retain a durable memory into Keystone and queue auto-push to remote Git.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title" },
          content: { type: "string", description: "Markdown body" },
          kind: { type: "string", description: "world | experience | observation" },
          bank_id: { type: "string", description: "Optional bank id (e.g. global)" }
        },
        required: ["title", "content"]
      },
      output: { schema: { type: "string" }, render },
      execute: (args, exec) =>
        withEngine(async (engine) => {
          const kind = (args.kind === "world" || args.kind === "experience" ? args.kind : "observation") as
            | "world"
            | "experience"
            | "observation";
          const { doc } = await engine.retain({
            cwd: agentCwd(exec?.agent),
            bankId: args.bank_id,
            kind,
            title: args.title,
            content: args.content,
            harness: "dsh",
            syncMode: "background"
          });
          return JSON.stringify({ retained: true, id: doc.id, filePath: doc.filePath }, null, 2);
        })
    });

    toolCtx.tools.register({
      name: "keystone_read_page",
      description: "Read a Mental Model page or Initiative by id, slug, or title.",
      parameters: {
        type: "object",
        properties: {
          id_or_slug: { type: "string", description: "Page id, slug, or title" },
          bank_id: { type: "string", description: "Optional bank id" }
        },
        required: ["id_or_slug"]
      },
      output: { schema: { type: "string" }, render },
      execute: (args, exec) =>
        withEngine(async (engine) => {
          const doc = engine.readPage(args.id_or_slug, agentCwd(exec?.agent), args.bank_id);
          return doc ? `# ${doc.title}\n\n${doc.content}` : `Not found: ${args.id_or_slug}`;
        })
    });

    toolCtx.tools.register({
      name: "keystone_pull",
      description: "Manually pull latest memories from remote Git and incrementally reindex.",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render },
      execute: () => withEngine(async (engine) => JSON.stringify(engine.pull(), null, 2))
    });

    toolCtx.tools.register({
      name: "keystone_sync_status",
      description: "Check Keystone remote Git sync status and memory bank statistics.",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "string" }, render },
      execute: (_args, exec) =>
        withEngine(async (engine) => JSON.stringify(engine.syncStatus(agentCwd(exec?.agent)), null, 2))
    });
  });
}

export default { name, inject, apply };

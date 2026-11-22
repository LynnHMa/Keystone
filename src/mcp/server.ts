import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildMemoryBundle } from "../core/bundle.js";
import { KeystoneEngine } from "../core/engine.js";
import type { HarnessName, MemoryKind } from "../core/types.js";

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function okJson(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

export function createKeystoneMcpServer(engine: KeystoneEngine, harness: HarnessName = "mcp"): McpServer {
  const server = new McpServer({
    name: "keystone",
    version: "0.1.0"
  });

  server.tool(
    "keystone_recall",
    "Hybrid 4-way memory recall (BM25 + optional vector + entity graph + authority/recency reranking) across the current repo's memory bank and global memory.",
    {
      query: z.string().describe("Natural language, code symbol, or Chinese/English search query."),
      cwd: z.string().optional().describe("Workspace directory for bank resolution (defaults to server cwd)."),
      bank_id: z.string().optional().describe("Optional explicit bank id (e.g. 'global' or 'repo--owner--name')."),
      kinds: z
        .array(z.enum(["world", "experience", "observation", "correction", "page", "initiative"]))
        .optional()
        .describe("Optional filter by memory layer kinds."),
      limit: z.number().int().min(1).max(30).optional().describe("Maximum results (default 8).")
    },
    async (args) => {
      const { bank, results } = await engine.recall({
        query: args.query,
        cwd: args.cwd,
        bankId: args.bank_id,
        kinds: args.kinds as MemoryKind[] | undefined,
        limit: args.limit ?? 8
      });
      return okJson({
        bank: bank.bankId,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          bankId: r.bankId,
          kind: r.kind,
          title: r.title,
          snippet: r.snippet,
          score: r.score,
          harness: r.harness,
          updatedAt: r.updatedAt,
          filePath: r.filePath
        }))
      });
    }
  );

  server.tool(
    "keystone_search_pages",
    "Search curated Mental Model pages and active Initiatives first for architecture, conventions, persona, and past decisions.",
    {
      query: z.string().describe("Topic or keywords to search across pages and initiatives."),
      cwd: z.string().optional(),
      bank_id: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional()
    },
    async (args) => {
      const { bank, results } = await engine.recall({
        query: args.query,
        cwd: args.cwd,
        bankId: args.bank_id,
        kinds: ["page", "initiative", "correction"],
        limit: args.limit ?? 6
      });
      return okJson({
        bank: bank.bankId,
        count: results.length,
        results: results.map((r) => ({
          id: r.id,
          bankId: r.bankId,
          kind: r.kind,
          title: r.title,
          snippet: r.snippet,
          score: r.score,
          harness: r.harness,
          updatedAt: r.updatedAt,
          filePath: r.filePath
        }))
      });
    }
  );

  server.tool(
    "keystone_list_pages",
    "List all curated Mental Model pages and active Initiatives in the current repo bank and global bank.",
    {
      cwd: z.string().optional(),
      bank_id: z.string().optional()
    },
    async (args) => {
      const pages = engine.listPages(args.cwd, args.bank_id);
      return okJson({
        count: pages.length,
        pages: pages.map((p) => ({
          id: p.id,
          bankId: p.bankId,
          kind: p.kind,
          title: p.title,
          updatedAt: p.updatedAt
        }))
      });
    }
  );

  server.tool(
    "keystone_read_page",
    "Read the full Markdown contents of a specific Mental Model page, Initiative, Observation, or Correction by id, slug, or title.",
    {
      id_or_slug: z.string().describe("Page id, filename slug, or exact title."),
      cwd: z.string().optional(),
      bank_id: z.string().optional()
    },
    async (args) => {
      const doc = engine.readPage(args.id_or_slug, args.cwd, args.bank_id);
      if (!doc) {
        return okText(`Memory document not found: ${args.id_or_slug}`);
      }
      return okText(
        `# ${doc.title}\n- ID: ${doc.id}\n- Bank: ${doc.bankId}\n- Kind: ${doc.kind}\n- File: ${doc.filePath}\n- Updated: ${doc.updatedAt}\n\n${doc.content}`
      );
    }
  );

  server.tool(
    "keystone_reflect",
    "Synthesize a structured, evidence-backed answer across all memory networks (prioritizing Corrections -> Pages -> Observations -> Episodes).",
    {
      query: z.string().describe("WHY-question, architecture inquiry, or synthesis prompt."),
      cwd: z.string().optional(),
      bank_id: z.string().optional(),
      limit: z.number().int().min(1).max(25).optional()
    },
    async (args) => {
      const out = await engine.reflect({
        query: args.query,
        cwd: args.cwd,
        bankId: args.bank_id,
        limit: args.limit ?? 12
      });
      return okText(out.synthesis);
    }
  );

  server.tool(
    "keystone_retain",
    "Store a durable fact (world), session lesson (experience), or consolidated belief (observation) into the Git-backed memory repo and trigger auto-push.",
    {
      title: z.string().describe("Short descriptive title."),
      content: z.string().describe("Markdown body of the memory."),
      kind: z.enum(["world", "experience", "observation"]).optional().describe("Memory layer (default: observation)."),
      cwd: z.string().optional(),
      bank_id: z.string().optional().describe("Use 'global' for cross-repo user/persona memory."),
      tags: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional().describe("Optional IDs of older memories this supersedes.")
    },
    async (args) => {
      const { doc } = await engine.retain({
        cwd: args.cwd,
        bankId: args.bank_id,
        kind: args.kind ?? "observation",
        title: args.title,
        content: args.content,
        tags: args.tags,
        supersedes: args.supersedes,
        harness,
        syncMode: "background"
      });
      return okJson({
        retained: true,
        id: doc.id,
        bankId: doc.bankId,
        kind: doc.kind,
        filePath: doc.filePath,
        autoPushQueued: engine.config.git.autoPush
      });
    }
  );

  server.tool(
    "keystone_correct",
    "Record a highest-authority Correction that permanently outranks a wrong or stale memory.",
    {
      topic: z.string().describe("Short topic name."),
      wrong_claim: z.string().describe("What memory previously claimed incorrectly."),
      truth: z.string().describe("What is verifiably true now."),
      evidence: z.string().optional().describe("File, commit, or command output checked."),
      supersedes: z.array(z.string()).optional().describe("Optional memory IDs to explicitly mark superseded."),
      cwd: z.string().optional(),
      bank_id: z.string().optional()
    },
    async (args) => {
      const { doc } = await engine.correct({
        cwd: args.cwd,
        bankId: args.bank_id,
        topic: args.topic,
        wrongClaim: args.wrong_claim,
        truth: args.truth,
        evidence: args.evidence,
        supersedes: args.supersedes,
        harness,
        syncMode: "background"
      });
      return okJson({
        corrected: true,
        id: doc.id,
        bankId: doc.bankId,
        filePath: doc.filePath
      });
    }
  );

  server.tool(
    "keystone_capture_initiative",
    "Create or update a living feature/project Initiative page in-place (same slug updates existing page).",
    {
      title: z.string().describe("Initiative title."),
      summary: z.string().describe("Current goal, scope, architecture plan, and status."),
      slug: z.string().optional().describe("Stable slug to update an existing initiative in-place."),
      cwd: z.string().optional(),
      bank_id: z.string().optional()
    },
    async (args) => {
      const { doc } = await engine.captureInitiative({
        cwd: args.cwd,
        bankId: args.bank_id,
        title: args.title,
        summary: args.summary,
        slug: args.slug,
        harness,
        syncMode: "background"
      });
      return okJson({
        saved: true,
        id: doc.id,
        bankId: doc.bankId,
        filePath: doc.filePath
      });
    }
  );

  server.tool(
    "keystone_upsert_page",
    "Create or update a curated Mental Model Wiki page (e.g. architecture, conventions, decisions, persona).",
    {
      title: z.string(),
      content: z.string(),
      slug: z.string().optional(),
      tags: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      bank_id: z.string().optional()
    },
    async (args) => {
      const { doc } = await engine.upsertPage({
        cwd: args.cwd,
        bankId: args.bank_id,
        slug: args.slug,
        title: args.title,
        content: args.content,
        tags: args.tags,
        harness,
        syncMode: "background"
      });
      return okJson({ saved: true, id: doc.id, bankId: doc.bankId, filePath: doc.filePath });
    }
  );

  server.tool(
    "keystone_pull",
    "Manually pull latest memories from the bound remote Git repository (rebase-safe) and incrementally reindex local SQLite.",
    {
      push_after: z.boolean().optional().describe("If true, push rebased local commits after pull succeeds.")
    },
    async (args) => {
      const res = engine.pull({ pushAfter: args.push_after });
      return okJson(res);
    }
  );

  server.tool(
    "keystone_push",
    "Commit and push local memory changes to the bound remote Git repository immediately.",
    {
      message: z.string().optional().describe("Optional commit message.")
    },
    async (args) => {
      const res = engine.push(args.message || `mem(sync): [${harness}] manual push`);
      return okJson(res);
    }
  );

  server.tool(
    "keystone_sync_status",
    "Report Keystone sync status, bound remote Git repo, ahead/behind counts, active bank stats, and runtime diagnostics.",
    {
      cwd: z.string().optional(),
      bank_id: z.string().optional()
    },
    async (args) => {
      const resolved = engine.resolveBankForCwd(args.cwd, args.bank_id);
      const status = engine.syncStatus(args.cwd, args.bank_id);
      return okJson({
        harness,
        resolvedBank: resolved,
        autoPush: engine.config.git.autoPush,
        autoRebaseOnPush: engine.config.git.autoRebaseOnPush,
        llmConfigured: engine.llm.isConfigured(),
        embeddingsConfigured: engine.llm.hasEmbeddings(),
        ...status
      });
    }
  );

  server.tool(
    "keystone_bundle",
    "Compile the memory bank into 3 clean Markdown files for web AI platforms (Gemini Gems + Google Drive, AI Studio, NotebookLM).",
    {
      bank_id: z.string().optional(),
      out_dir: z.string().optional(),
      max_episodes: z.number().int().min(1).max(200).optional()
    },
    async (args) => {
      const res = buildMemoryBundle(engine, {
        bankId: args.bank_id,
        outDir: args.out_dir,
        maxEpisodes: args.max_episodes ?? 30
      });
      return okJson(res);
    }
  );

  return server;
}

export async function startMcpStdioServer(): Promise<void> {
  const harness = (process.env.KEYSTONE_MCP_HARNESS || "mcp") as HarnessName;
  const engine = new KeystoneEngine();
  const server = createKeystoneMcpServer(engine, harness);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

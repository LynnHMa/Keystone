#!/usr/bin/env node
import { runHookCommand } from "../adapters/hooks.js";
import { buildMemoryBundle } from "../core/bundle.js";
import { configPath, loadConfig, saveConfig } from "../core/config.js";
import { KeystoneEngine } from "../core/engine.js";
import { importCodexMemories } from "../importers/codex-memories.js";
import { importDshMdcg } from "../importers/dsh-mdcg.js";
import {
  installTargets,
  uninstallTargets,
  type InstallTarget
} from "../installer/install.js";
import { startMcpStdioServer } from "../mcp/server.js";

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function parseInstallTargets(args: string[]): InstallTarget[] {
  if (args.length === 0 || args.includes("all")) {
    return ["claude", "codex", "dsh", "antigravity"];
  }
  const map: Record<string, InstallTarget> = {
    claude: "claude",
    "claude-code": "claude",
    codex: "codex",
    dsh: "dsh",
    antigravity: "antigravity",
    "antigravity-cli": "antigravity"
  };
  const out = new Set<InstallTarget>();
  for (const a of args) {
    const mapped = map[a.toLowerCase()];
    if (!mapped) throw new Error(`Unknown harness target: ${a}`);
    out.add(mapped);
  }
  return [...out];
}

function printHelp(): void {
  console.log(`Keystone — Git-backed shared agent memory (Claude / Codex / dsh / Antigravity)

Usage:
  keystone init [--remote <git-url>] [--branch main] [--auto-rebase]
  keystone bind <git-url>
  keystone status [--bank <id>]
  keystone pull [--push-after]
  keystone push [--message "..."] [--quiet]
  keystone retain <title> <content> [--kind world|experience|observation] [--bank <id>]
  keystone recall <query> [--bank <id>] [--limit 8]
  keystone reflect <query> [--bank <id>]
  keystone correct <topic> --wrong "..." --truth "..." [--evidence "..."] [--bank <id>]
  keystone pages [--bank <id>]
  keystone seed [repo-dir] [--limit 60]
  keystone reindex
  keystone bundle [--out <dir>] [--bank global] [--max-episodes 30]
  keystone import-dsh <path-to-.dsh-memory> [--bank global] [--keep-noise] [--no-commit]
  keystone import-codex <dir1> [dir2...] [--bank global] [--no-commit]
  keystone install [all | claude codex dsh antigravity]
  keystone uninstall [all | claude codex dsh antigravity]
  keystone mcp
  keystone hook <claude-code|codex|antigravity-cli> <session-start|prompt|stop>
  keystone doctor
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "mcp") {
    await startMcpStdioServer();
    return;
  }

  if (cmd === "hook") {
    const harness = rest[0] as "claude-code" | "codex" | "antigravity-cli";
    const event = rest[1] as "session-start" | "prompt" | "stop";
    await runHookCommand(harness, event);
    return;
  }

  const { positional, flags } = parseFlags(rest);

  if (cmd === "install") {
    const targets = parseInstallTargets(positional);
    const results = installTargets(targets);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (cmd === "uninstall") {
    const targets = parseInstallTargets(positional);
    const results = uninstallTargets(targets);
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const engine = new KeystoneEngine();
  try {
    switch (cmd) {
      case "init": {
        const remote = typeof flags.remote === "string" ? flags.remote : positional[0];
        if (typeof flags.branch === "string") engine.config.git.branch = flags.branch;
        if (flags["auto-rebase"] === true) engine.config.git.autoRebaseOnPush = true;
        if (flags["no-auto-push"] === true) engine.config.git.autoPush = false;
        saveConfig(engine.config);
        const res = engine.init(remote);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "bind": {
        const remote = positional[0];
        if (!remote) throw new Error("Missing <git-url>. Example: keystone bind git@github.com:you/memory.git");
        engine.bind(remote);
        console.log(JSON.stringify({ bound: true, remoteUrl: remote, repoDir: engine.config.repoDir }, null, 2));
        break;
      }

      case "status":
      case "doctor": {
        const bankId = typeof flags.bank === "string" ? flags.bank : undefined;
        const status = engine.syncStatus(process.cwd(), bankId);
        console.log(
          JSON.stringify(
            {
              configPath: configPath(),
              autoPush: engine.config.git.autoPush,
              autoRebaseOnPush: engine.config.git.autoRebaseOnPush,
              llmConfigured: engine.llm.isConfigured(),
              banks: engine.store.listBanks(),
              ...status
            },
            null,
            2
          )
        );
        break;
      }

      case "pull": {
        const res = engine.pull({ pushAfter: flags["push-after"] === true });
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        break;
      }

      case "push": {
        const message = typeof flags.message === "string" ? flags.message : "mem(sync): manual push";
        const res = engine.push(message);
        if (!flags.quiet) {
          console.log(JSON.stringify(res, null, 2));
        }
        if (!res.ok && !flags.quiet) process.exitCode = 1;
        break;
      }

      case "retain": {
        const [title, ...contentParts] = positional;
        const content = contentParts.join(" ");
        if (!title || !content) throw new Error("Usage: keystone retain <title> <content>");
        const kind = (typeof flags.kind === "string" ? flags.kind : "observation") as
          | "world"
          | "experience"
          | "observation";
        const bankId = typeof flags.bank === "string" ? flags.bank : undefined;
        const res = await engine.retain({
          cwd: process.cwd(),
          bankId,
          kind,
          title,
          content,
          harness: "cli",
          syncMode: flags["no-push"] ? "none" : "immediate"
        });
        console.log(JSON.stringify({ id: res.doc.id, filePath: res.doc.filePath, push: res.pushResult }, null, 2));
        break;
      }

      case "correct": {
        const topic = positional.join(" ");
        const wrong = typeof flags.wrong === "string" ? flags.wrong : "";
        const truth = typeof flags.truth === "string" ? flags.truth : "";
        const evidence = typeof flags.evidence === "string" ? flags.evidence : undefined;
        if (!topic || !wrong || !truth) {
          throw new Error('Usage: keystone correct <topic> --wrong "..." --truth "..."');
        }
        const res = await engine.correct({
          cwd: process.cwd(),
          bankId: typeof flags.bank === "string" ? flags.bank : undefined,
          topic,
          wrongClaim: wrong,
          truth,
          evidence,
          harness: "cli",
          syncMode: "immediate"
        });
        console.log(JSON.stringify({ id: res.doc.id, filePath: res.doc.filePath, push: res.pushResult }, null, 2));
        break;
      }

      case "recall": {
        const query = positional.join(" ");
        if (!query) throw new Error("Usage: keystone recall <query>");
        const limit = typeof flags.limit === "string" ? Number(flags.limit) : 8;
        const bankId = typeof flags.bank === "string" ? flags.bank : undefined;
        const res = await engine.recall({ cwd: process.cwd(), bankId, query, limit });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "reflect": {
        const query = positional.join(" ");
        if (!query) throw new Error("Usage: keystone reflect <query>");
        const bankId = typeof flags.bank === "string" ? flags.bank : undefined;
        const res = await engine.reflect({ cwd: process.cwd(), bankId, query });
        console.log(res.synthesis);
        break;
      }

      case "pages": {
        const bankId = typeof flags.bank === "string" ? flags.bank : undefined;
        const pages = engine.listPages(process.cwd(), bankId);
        console.log(
          JSON.stringify(
            pages.map((p) => ({
              id: p.id,
              bankId: p.bankId,
              kind: p.kind,
              title: p.title,
              filePath: p.filePath
            })),
            null,
            2
          )
        );
        break;
      }

      case "seed": {
        const target = positional[0] || process.cwd();
        const limit = typeof flags.limit === "string" ? Number(flags.limit) : 60;
        const res = await engine.seedGitHistory(target, limit);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "reindex": {
        const res = engine.index.fullReindex(engine.store);
        console.log(JSON.stringify({ reindexed: res.indexed, removed: res.removed }, null, 2));
        break;
      }

      case "bundle": {
        const outDir = typeof flags.out === "string" ? flags.out : undefined;
        const bankId = typeof flags.bank === "string" ? flags.bank : undefined;
        const maxEpisodes = typeof flags["max-episodes"] === "string" ? Number(flags["max-episodes"]) : 30;
        const res = buildMemoryBundle(engine, { bankId, outDir, maxEpisodes });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "import-dsh": {
        const src = positional[0];
        if (!src) throw new Error("Usage: keystone import-dsh <path-to-.dsh-memory>");
        const bankId = typeof flags.bank === "string" ? flags.bank : "global";
        const report = await importDshMdcg(engine, src, {
          bankId,
          commit: flags["no-commit"] !== true,
          filterNoise: flags["keep-noise"] !== true
        });
        console.log(JSON.stringify(report, null, 2));
        break;
      }

      case "import-codex": {
        if (positional.length === 0) {
          throw new Error("Usage: keystone import-codex <dir1> [dir2...] [--bank global]");
        }
        const bankId = typeof flags.bank === "string" ? flags.bank : "global";
        const report = await importCodexMemories(engine, positional, {
          bankId,
          commit: flags["no-commit"] !== true
        });
        console.log(JSON.stringify(report, null, 2));
        break;
      }

      default:
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    engine.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

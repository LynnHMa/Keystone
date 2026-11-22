import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type InstallTarget = "claude" | "codex" | "dsh" | "antigravity";

export interface InstallActionResult {
  target: InstallTarget;
  changed: boolean;
  files: string[];
  note: string;
}

function distRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

function cliEntryPath(): string {
  return join(distRoot(), "cli", "index.js");
}

function dshPluginUrl(): string {
  return pathToFileURL(join(distRoot(), "adapters", "dsh-plugin.js")).href;
}

function backupIfExists(filePath: string): void {
  if (!existsSync(filePath)) return;
  const bak = `${filePath}.keystone-backup`;
  if (!existsSync(bak)) {
    copyFileSync(filePath, bak);
  }
}

function readJsonSafe(filePath: string): Record<string, any> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
  } catch {
    return {};
  }
}

function writeJsonPretty(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function upsertNestedHook(
  settings: Record<string, any>,
  eventName: string,
  command: string,
  timeout: number
): void {
  settings.hooks ??= {};
  settings.hooks[eventName] ??= [];
  const entries = settings.hooks[eventName] as Array<{ hooks?: Array<{ command?: string }> }>;
  // Remove any previous keystone hook for this event
  settings.hooks[eventName] = entries.filter(
    (entry) => !(entry.hooks ?? []).some((h) => h.command?.includes("keystone") || h.command?.includes(cliEntryPath()))
  );
  settings.hooks[eventName].push({
    hooks: [{ type: "command", command, timeout }]
  });
}

function removeNestedHooks(settings: Record<string, any>): void {
  if (!settings.hooks || typeof settings.hooks !== "object") return;
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) continue;
    settings.hooks[ev] = settings.hooks[ev].filter(
      (entry: { hooks?: Array<{ command?: string }> }) =>
        !(entry.hooks ?? []).some((h) => h.command?.includes("keystone"))
    );
  }
}

function installClaude(): InstallActionResult {
  const home = homedir();
  const cli = cliEntryPath();
  const files: string[] = [];

  // 1. MCP in ~/.claude.json
  const claudeJson = join(home, ".claude.json");
  backupIfExists(claudeJson);
  const cj = readJsonSafe(claudeJson);
  cj.mcpServers ??= {};
  cj.mcpServers.keystone = {
    command: "node",
    args: [cli, "mcp"],
    env: { KEYSTONE_MCP_HARNESS: "claude-code" }
  };
  writeJsonPretty(claudeJson, cj);
  files.push(claudeJson);

  // 2. Hooks in ~/.claude/settings.json
  const settingsPath = join(home, ".claude", "settings.json");
  backupIfExists(settingsPath);
  const settings = readJsonSafe(settingsPath);
  upsertNestedHook(settings, "SessionStart", `node "${cli}" hook claude-code session-start`, 15);
  upsertNestedHook(settings, "UserPromptSubmit", `node "${cli}" hook claude-code prompt`, 15);
  upsertNestedHook(settings, "Stop", `node "${cli}" hook claude-code stop`, 30);
  writeJsonPretty(settingsPath, settings);
  files.push(settingsPath);

  return {
    target: "claude",
    changed: true,
    files,
    note: "Registered MCP + SessionStart/UserPromptSubmit/Stop hooks (takes effect on next Claude session)."
  };
}

function uninstallClaude(): InstallActionResult {
  const home = homedir();
  const files: string[] = [];
  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson)) {
    const cj = readJsonSafe(claudeJson);
    if (cj.mcpServers?.keystone) {
      delete cj.mcpServers.keystone;
      writeJsonPretty(claudeJson, cj);
      files.push(claudeJson);
    }
  }
  const settingsPath = join(home, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const settings = readJsonSafe(settingsPath);
    removeNestedHooks(settings);
    writeJsonPretty(settingsPath, settings);
    files.push(settingsPath);
  }
  return { target: "claude", changed: files.length > 0, files, note: "Removed Keystone from Claude Code." };
}

function installCodex(): InstallActionResult {
  const home = homedir();
  const cli = cliEntryPath();
  const files: string[] = [];

  // 1. MCP block in ~/.codex/config.toml (idempotent marker block)
  const tomlPath = join(home, ".codex", "config.toml");
  mkdirSync(dirname(tomlPath), { recursive: true });
  backupIfExists(tomlPath);
  const startMark = "# KEYSTONE_MCP_START";
  const endMark = "# KEYSTONE_MCP_END";
  const block = [
    startMark,
    "[mcp_servers.keystone]",
    `command = "node"`,
    `args = [${JSON.stringify(cli)}, "mcp"]`,
    `env = { KEYSTONE_MCP_HARNESS = "codex" }`,
    endMark
  ].join("\n");

  let existing = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const regex = new RegExp(`${startMark}[\\s\\S]*?${endMark}\\r?\\n?`, "g");
  existing = existing.replace(regex, "").trimEnd();
  writeFileSync(tomlPath, (existing ? existing + "\n\n" : "") + block + "\n", "utf8");
  files.push(tomlPath);

  // 2. Hooks in ~/.codex/hooks.json
  const hooksPath = join(home, ".codex", "hooks.json");
  backupIfExists(hooksPath);
  const hooks = readJsonSafe(hooksPath);
  upsertNestedHook(hooks, "SessionStart", `node "${cli}" hook codex session-start`, 15);
  upsertNestedHook(hooks, "UserPromptSubmit", `node "${cli}" hook codex prompt`, 15);
  upsertNestedHook(hooks, "Stop", `node "${cli}" hook codex stop`, 30);
  writeJsonPretty(hooksPath, hooks);
  files.push(hooksPath);

  return {
    target: "codex",
    changed: true,
    files,
    note: "Registered MCP in config.toml + hooks in hooks.json (takes effect on next Codex turn/session)."
  };
}

function uninstallCodex(): InstallActionResult {
  const home = homedir();
  const files: string[] = [];
  const tomlPath = join(home, ".codex", "config.toml");
  if (existsSync(tomlPath)) {
    const raw = readFileSync(tomlPath, "utf8");
    const next = raw.replace(/# KEYSTONE_MCP_START[\s\S]*?# KEYSTONE_MCP_END\r?\n?/g, "").trimEnd() + "\n";
    if (next !== raw) {
      writeFileSync(tomlPath, next, "utf8");
      files.push(tomlPath);
    }
  }
  const hooksPath = join(home, ".codex", "hooks.json");
  if (existsSync(hooksPath)) {
    const hooks = readJsonSafe(hooksPath);
    removeNestedHooks(hooks);
    writeJsonPretty(hooksPath, hooks);
    files.push(hooksPath);
  }
  return { target: "codex", changed: files.length > 0, files, note: "Removed Keystone from Codex." };
}

function installDsh(): InstallActionResult {
  const home = homedir();
  const patchPath = join(home, ".dsh", "cordis.patch.yml");
  mkdirSync(dirname(patchPath), { recursive: true });
  backupIfExists(patchPath);

  const startMark = "# KEYSTONE_DSH_START";
  const endMark = "# KEYSTONE_DSH_END";
  const block = [
    startMark,
    "- insert:",
    "    - id: keystone",
    `      name: ${JSON.stringify(dshPluginUrl())}`,
    endMark
  ].join("\n");

  let existing = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const regex = new RegExp(`${startMark}[\\s\\S]*?${endMark}\\r?\\n?`, "g");
  existing = existing.replace(regex, "").trimEnd();
  writeFileSync(patchPath, (existing ? existing + "\n\n" : "") + block + "\n", "utf8");

  return {
    target: "dsh",
    changed: true,
    files: [patchPath],
    note: "Registered native Cordis plugin in ~/.dsh/cordis.patch.yml (restart dsh when convenient to load)."
  };
}

function uninstallDsh(): InstallActionResult {
  const home = homedir();
  const patchPath = join(home, ".dsh", "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    return { target: "dsh", changed: false, files: [], note: "Nothing to remove." };
  }
  const raw = readFileSync(patchPath, "utf8");
  const next = raw.replace(/# KEYSTONE_DSH_START[\s\S]*?# KEYSTONE_DSH_END\r?\n?/g, "").trimEnd();
  writeFileSync(patchPath, next ? next + "\n" : "", "utf8");
  return { target: "dsh", changed: next !== raw, files: [patchPath], note: "Removed Keystone from dsh." };
}

function installAntigravity(): InstallActionResult {
  const home = homedir();
  const cli = cliEntryPath();
  const configDir = join(home, ".gemini", "config");
  const files: string[] = [];

  // 1. MCP in ~/.gemini/config/mcp_config.json
  const mcpPath = join(configDir, "mcp_config.json");
  backupIfExists(mcpPath);
  const mcp = readJsonSafe(mcpPath);
  mcp.mcpServers ??= {};
  mcp.mcpServers.keystone = {
    command: "node",
    args: [cli, "mcp"],
    env: { KEYSTONE_MCP_HARNESS: "antigravity-cli" }
  };
  writeJsonPretty(mcpPath, mcp);
  files.push(mcpPath);

  // 2. Hooks in ~/.gemini/config/hooks.json
  const hooksPath = join(configDir, "hooks.json");
  backupIfExists(hooksPath);
  const hooks = readJsonSafe(hooksPath);
  hooks["coding-agents"] ??= {};
  for (const [ev, subCmd, timeout] of [
    ["PreInvocation", "prompt", 15],
    ["Stop", "stop", 30]
  ] as const) {
    const arr = Array.isArray(hooks["coding-agents"][ev]) ? hooks["coding-agents"][ev] : [];
    hooks["coding-agents"][ev] = arr.filter((h: { command?: string }) => !h.command?.includes("keystone"));
    hooks["coding-agents"][ev].push({
      command: `node "${cli}" hook antigravity-cli ${subCmd}`,
      timeout
    });
  }
  writeJsonPretty(hooksPath, hooks);
  files.push(hooksPath);

  // 3. Skill in ~/.gemini/config/skills/keystone/SKILL.md
  const skillPath = join(configDir, "skills", "keystone", "SKILL.md");
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(
    skillPath,
    `---
name: keystone
description: Shared Git-backed Hindsight-style long-term memory across Claude Code, Codex, dsh, and Antigravity. Use when recalling project/user memory, saving findings, recording corrections, or syncing (pull/push) memory with the remote Git repository.
---

# Keystone Shared Agent Memory

This machine shares one Git-backed memory repository across **Claude Code**, **Codex**, **dsh**, and **Antigravity**.

## Key MCP Tools
- \`keystone_search_pages(query)\` / \`keystone_list_pages()\` / \`keystone_read_page(id_or_slug)\` — First stop for architecture, persona, conventions, and initiatives.
- \`keystone_recall(query)\` — 4-way hybrid search (BM25 + Graph + optional Vector + Authority/Recency).
- \`keystone_reflect(query)\` — Evidence-backed synthesis prioritizing Corrections > Pages > Observations > Episodes.
- \`keystone_retain(title, content, kind)\` — Store durable memories (automatically triggers background Git push).
- \`keystone_correct(topic, wrong_claim, truth, evidence)\` — Permanently supersede stale/wrong facts.
- \`keystone_pull()\` / \`keystone_push()\` / \`keystone_sync_status()\` — Manually pull remote updates (with millisecond SQLite incremental reindex) or force a push check.
`,
    "utf8"
  );
  files.push(skillPath);

  return {
    target: "antigravity",
    changed: true,
    files,
    note: "Registered MCP + PreInvocation/Stop hooks + keystone Skill."
  };
}

function uninstallAntigravity(): InstallActionResult {
  const home = homedir();
  const configDir = join(home, ".gemini", "config");
  const files: string[] = [];

  const mcpPath = join(configDir, "mcp_config.json");
  if (existsSync(mcpPath)) {
    const mcp = readJsonSafe(mcpPath);
    if (mcp.mcpServers?.keystone) {
      delete mcp.mcpServers.keystone;
      writeJsonPretty(mcpPath, mcp);
      files.push(mcpPath);
    }
  }
  const hooksPath = join(configDir, "hooks.json");
  if (existsSync(hooksPath)) {
    const hooks = readJsonSafe(hooksPath);
    if (hooks["coding-agents"]) {
      for (const ev of ["PreInvocation", "Stop"]) {
        if (Array.isArray(hooks["coding-agents"][ev])) {
          hooks["coding-agents"][ev] = hooks["coding-agents"][ev].filter(
            (h: { command?: string }) => !h.command?.includes("keystone")
          );
        }
      }
      writeJsonPretty(hooksPath, hooks);
      files.push(hooksPath);
    }
  }
  return { target: "antigravity", changed: files.length > 0, files, note: "Removed Keystone from Antigravity." };
}

export function installTargets(targets: InstallTarget[]): InstallActionResult[] {
  const out: InstallActionResult[] = [];
  for (const t of targets) {
    if (t === "claude") out.push(installClaude());
    else if (t === "codex") out.push(installCodex());
    else if (t === "dsh") out.push(installDsh());
    else if (t === "antigravity") out.push(installAntigravity());
  }
  return out;
}

export function uninstallTargets(targets: InstallTarget[]): InstallActionResult[] {
  const out: InstallActionResult[] = [];
  for (const t of targets) {
    if (t === "claude") out.push(uninstallClaude());
    else if (t === "codex") out.push(uninstallCodex());
    else if (t === "dsh") out.push(uninstallDsh());
    else if (t === "antigravity") out.push(uninstallAntigravity());
  }
  return out;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { KeystoneConfig } from "./types.js";

export function keystoneHome(): string {
  return resolve(process.env.KEYSTONE_HOME || join(homedir(), ".keystone"));
}

export function configPath(): string {
  return process.env.KEYSTONE_CONFIG || join(keystoneHome(), "config.json");
}

export function defaultConfig(): KeystoneConfig {
  return {
    repoDir: join(keystoneHome(), "repo"),
    git: {
      branch: "main",
      autoPush: true,
      autoRebaseOnPush: false,
      debounceMs: 3000
    },
    globalBankId: "global",
    autoInject: "both",
    maxInjectChars: 6000,
    redactSecrets: true,
    harnesses: {}
  };
}

export function loadConfig(): KeystoneConfig {
  const base = defaultConfig();
  const file = configPath();
  let fileCfg: Partial<KeystoneConfig> = {};

  if (existsSync(file)) {
    try {
      fileCfg = JSON.parse(readFileSync(file, "utf8")) as Partial<KeystoneConfig>;
    } catch {
      fileCfg = {};
    }
  }

  const merged: KeystoneConfig = {
    ...base,
    ...fileCfg,
    git: {
      ...base.git,
      ...(fileCfg.git ?? {})
    },
    llm: fileCfg.llm ? { ...fileCfg.llm } : undefined,
    harnesses: {
      ...base.harnesses,
      ...(fileCfg.harnesses ?? {})
    }
  };

  if (process.env.KEYSTONE_REPO_DIR) {
    merged.repoDir = resolve(process.env.KEYSTONE_REPO_DIR);
  }
  if (process.env.KEYSTONE_REMOTE_URL) {
    merged.git.remoteUrl = process.env.KEYSTONE_REMOTE_URL;
  }
  if (process.env.KEYSTONE_AUTO_PUSH !== undefined) {
    merged.git.autoPush = process.env.KEYSTONE_AUTO_PUSH !== "false";
  }
  if (process.env.KEYSTONE_AUTO_REBASE !== undefined) {
    merged.git.autoRebaseOnPush = process.env.KEYSTONE_AUTO_REBASE === "true";
  }
  if (process.env.KEYSTONE_LLM_API_KEY || process.env.KEYSTONE_LLM_BASE_URL) {
    merged.llm = {
      ...(merged.llm ?? {}),
      baseUrl: process.env.KEYSTONE_LLM_BASE_URL || merged.llm?.baseUrl || "https://api.openai.com/v1",
      apiKey: process.env.KEYSTONE_LLM_API_KEY || merged.llm?.apiKey,
      model: process.env.KEYSTONE_LLM_MODEL || merged.llm?.model || "gpt-4o-mini",
      embeddingModel: process.env.KEYSTONE_EMBEDDING_MODEL || merged.llm?.embeddingModel
    };
  }

  return merged;
}

export function saveConfig(cfg: KeystoneConfig): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

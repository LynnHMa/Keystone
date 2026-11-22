import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface ResolvedBank {
  bankId: string;
  repoName: string;
  repoRoot: string | null;
  remoteUrl: string | null;
}

export function sanitizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Normalizes a git remote URL into a portable owner--repo slug so Windows, macOS,
 * Linux, and git worktrees all resolve to the exact same shared Memory Bank.
 */
export function normalizeRemoteSlug(remoteUrl: string): string {
  const cleaned = remoteUrl.trim().replace(/\.git$/i, "");
  // git@github.com:owner/repo or https://github.com/owner/repo
  const sshMatch = cleaned.match(/[:/]([^/:]+)\/([^/:]+)$/);
  if (sshMatch) {
    return sanitizeSlug(`${sshMatch[1]}--${sshMatch[2]}`);
  }
  return sanitizeSlug(basename(cleaned));
}

export function resolveBank(cwd?: string, explicitBankId?: string): ResolvedBank {
  if (explicitBankId && explicitBankId.trim()) {
    const clean = sanitizeSlug(explicitBankId);
    return {
      bankId: clean,
      repoName: clean,
      repoRoot: cwd && existsSync(cwd) ? resolve(cwd) : null,
      remoteUrl: null
    };
  }

  const targetDir = cwd && existsSync(cwd) ? resolve(cwd) : process.cwd();
  // Resolve main worktree root so linked worktrees share the primary repo's memory bank.
  const commonDir = runGit(targetDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const topLevel = runGit(targetDir, ["rev-parse", "--show-toplevel"]);
  const repoRoot = topLevel || null;

  if (repoRoot) {
    const remoteUrl = runGit(repoRoot, ["config", "--get", "remote.origin.url"]);
    if (remoteUrl) {
      const slug = normalizeRemoteSlug(remoteUrl);
      return {
        bankId: `repo--${slug}`,
        repoName: slug.replace(/--/g, "/"),
        repoRoot,
        remoteUrl
      };
    }

    const baseDir = commonDir && commonDir.endsWith(".git")
      ? basename(resolve(commonDir, ".."))
      : basename(repoRoot);
    const slug = sanitizeSlug(baseDir);
    return {
      bankId: `repo--${slug}`,
      repoName: baseDir,
      repoRoot,
      remoteUrl: null
    };
  }

  // Not inside a git repository -> fall back to global bank
  return {
    bankId: "global",
    repoName: "global",
    repoRoot: null,
    remoteUrl: null
  };
}

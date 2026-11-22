import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { LocalMemoryIndex } from "./index-db.js";
import type { GitMemoryStore } from "./store.js";
import type { GitSyncConfig, PullResult, PushResult, SyncStatusReport } from "./types.js";

interface GitExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], timeoutMs = 20000): GitExecResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout).trim() : "",
      stderr: e.stderr ? String(e.stderr).trim() : e.message ?? "git error"
    };
  }
}

function acquireLock(lockPath: string, timeoutMs = 6000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, `${process.pid}:${Date.now()}\n`, { flag: "wx" });
      return true;
    } catch {
      // Stale lock recovery (> 2 minutes old)
      try {
        const ageMs = Date.now() - Number(execFileSync("node", ["-e", `console.log(require('fs').statSync(${JSON.stringify(lockPath)}).mtimeMs)`], { encoding: "utf8", windowsHide: true }).trim());
        if (ageMs > 120_000) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // ignore
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    }
  }
  return false;
}

function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // ignore
  }
}

export class GitSyncManager {
  private readonly lockPath: string;

  constructor(
    private readonly repoDir: string,
    private readonly gitCfg: GitSyncConfig,
    private readonly store: GitMemoryStore,
    private readonly index: LocalMemoryIndex
  ) {
    this.lockPath = join(repoDir, ".cache", "sync.lock");
  }

  isInitialized(): boolean {
    return existsSync(join(this.repoDir, ".git"));
  }

  /**
   * Initializes the local memory git repository and optionally binds a remote URL.
   * If the directory is not yet a git repo and a remote URL is supplied, attempts to clone first
   * (falling back cleanly to local `git init` if the remote is brand new / empty).
   */
  initRepo(remoteUrl?: string): { initialized: boolean; cloned: boolean; message: string } {
    mkdirSync(this.repoDir, { recursive: true });
    const branch = this.gitCfg.branch || "main";
    let cloned = false;

    if (!this.isInitialized()) {
      const initRes = runGit(this.repoDir, ["init", "-b", branch]);
      if (!initRes.ok) {
        runGit(this.repoDir, ["init"]);
        runGit(this.repoDir, ["checkout", "-B", branch]);
      }

      const targetRemote = remoteUrl || this.gitCfg.remoteUrl;
      if (targetRemote) {
        this.bindRemote(targetRemote);
        const fetched = runGit(this.repoDir, ["fetch", "origin"], 30000);
        if (fetched.ok) {
          const hasBranch = runGit(this.repoDir, ["rev-parse", "--verify", `origin/${branch}`]).ok;
          const ref = hasBranch
            ? `origin/${branch}`
            : runGit(this.repoDir, ["rev-parse", "--verify", "origin/HEAD"]).ok
              ? "origin/HEAD"
              : null;
          if (ref) {
            const co = runGit(this.repoDir, ["checkout", "-f", "-B", branch, ref]);
            if (co.ok) {
              runGit(this.repoDir, ["branch", "--set-upstream-to", ref, branch]);
              cloned = true;
            }
          }
        }
      }
    }

    // Ensure repo-local author fallback so commits succeed even on unconfigured machines
    if (this.gitCfg.commitAuthorName) {
      runGit(this.repoDir, ["config", "user.name", this.gitCfg.commitAuthorName]);
    } else if (!runGit(this.repoDir, ["config", "user.name"]).ok) {
      runGit(this.repoDir, ["config", "user.name", "Keystone Memory"]);
    }
    if (this.gitCfg.commitAuthorEmail) {
      runGit(this.repoDir, ["config", "user.email", this.gitCfg.commitAuthorEmail]);
    } else if (!runGit(this.repoDir, ["config", "user.email"]).ok) {
      runGit(this.repoDir, ["config", "user.email", "keystone@local"]);
    }

    this.store.ensureBaseLayout();

    const effectiveRemote = remoteUrl || this.gitCfg.remoteUrl;
    if (effectiveRemote) {
      this.bindRemote(effectiveRemote);
    }

    // Ensure initial commit exists
    if (!runGit(this.repoDir, ["rev-parse", "--verify", "HEAD"]).ok) {
      runGit(this.repoDir, ["add", "-A"]);
      runGit(this.repoDir, ["commit", "-m", "chore(keystone): initialize shared agent memory repository"]);
    }

    const reindexed = this.index.fullReindex(this.store);
    return {
      initialized: true,
      cloned,
      message: cloned
        ? `Cloned remote memory repo (${reindexed.indexed} memories indexed).`
        : `Initialized Keystone repo at ${this.repoDir} (${reindexed.indexed} memories indexed).`
    };
  }

  bindRemote(remoteUrl: string): void {
    const existing = runGit(this.repoDir, ["remote", "get-url", "origin"]);
    if (existing.ok) {
      runGit(this.repoDir, ["remote", "set-url", "origin", remoteUrl]);
    } else {
      runGit(this.repoDir, ["remote", "add", "origin", remoteUrl]);
    }
  }

  getRemoteUrl(): string | null {
    const res = runGit(this.repoDir, ["remote", "get-url", "origin"]);
    return res.ok && res.stdout ? res.stdout : null;
  }

  getCurrentBranch(): string {
    const res = runGit(this.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return res.ok && res.stdout && res.stdout !== "HEAD" ? res.stdout : this.gitCfg.branch || "main";
  }

  /**
   * Commits local memory changes and pushes to remote if bound.
   * Never uses --force. Handles remote-ahead safely according to `autoRebaseOnPush`.
   */
  commitAndPush(reason: string, opts: { push?: boolean } = {}): PushResult {
    if (!this.isInitialized()) {
      this.initRepo();
    }
    mkdirSync(join(this.repoDir, ".cache"), { recursive: true });
    if (!acquireLock(this.lockPath)) {
      return { ok: false, committed: false, pushed: false, message: "Sync lock busy; retry shortly." };
    }

    try {
      const shouldPush = opts.push ?? this.gitCfg.autoPush;
      let committed = false;
      let commitHash: string | undefined;

      const status = runGit(this.repoDir, ["status", "--porcelain"]);
      if (status.ok && status.stdout.length > 0) {
        runGit(this.repoDir, ["add", "-A"]);
        const commitRes = runGit(this.repoDir, ["commit", "-m", reason]);
        if (commitRes.ok) {
          committed = true;
          commitHash = runGit(this.repoDir, ["rev-parse", "--short", "HEAD"]).stdout;
        }
      } else {
        commitHash = runGit(this.repoDir, ["rev-parse", "--short", "HEAD"]).stdout || undefined;
      }

      const remote = this.getRemoteUrl();
      if (!shouldPush || !remote) {
        return {
          ok: true,
          committed,
          pushed: false,
          commitHash,
          message: !remote
            ? committed
              ? `Committed locally (${commitHash}). No remote bound yet.`
              : "Working tree clean. No remote bound yet."
            : committed
              ? `Committed locally (${commitHash}); autoPush disabled.`
              : "Working tree clean."
        };
      }

      const branch = this.getCurrentBranch();
      let pushRes = runGit(this.repoDir, ["push", "-u", "origin", branch], 25000);

      if (!pushRes.ok && isNonFastForward(pushRes.stderr)) {
        if (this.gitCfg.autoRebaseOnPush) {
          runGit(this.repoDir, ["fetch", "origin", branch], 20000);
          const rebase = runGit(this.repoDir, ["rebase", `origin/${branch}`], 20000);
          if (rebase.ok) {
            // Reindex anything pulled during rebase
            const changed = runGit(this.repoDir, ["diff", "--name-only", "ORIG_HEAD", "HEAD"]);
            if (changed.ok && changed.stdout) {
              this.index.syncFiles(this.store, changed.stdout.split(/\r?\n/).filter(Boolean));
            }
            pushRes = runGit(this.repoDir, ["push", "-u", "origin", branch], 25000);
          } else {
            runGit(this.repoDir, ["rebase", "--abort"]);
          }
        }

        if (!pushRes.ok) {
          this.index.setState("push_pending", "true");
          this.index.setState("remote_ahead", "true");
          this.index.setState("last_error", "Remote has newer commits; run manual pull.");
          return {
            ok: false,
            committed,
            pushed: false,
            remoteAhead: true,
            commitHash,
            message:
              "Local memory committed safely, but remote has newer commits. Run `keystone pull` (or call `keystone_pull`) to sync and then push."
          };
        }
      }

      if (!pushRes.ok) {
        this.index.setState("push_pending", "true");
        this.index.setState("last_error", pushRes.stderr.slice(0, 240));
        return {
          ok: false,
          committed,
          pushed: false,
          commitHash,
          message: `Push failed (saved locally): ${pushRes.stderr.slice(0, 200)}`
        };
      }

      const now = new Date().toISOString();
      this.index.setState("push_pending", "false");
      this.index.setState("remote_ahead", "false");
      this.index.setState("last_push_at", now);
      this.index.setState("last_error", "");

      return {
        ok: true,
        committed,
        pushed: true,
        commitHash,
        message: committed
          ? `Committed (${commitHash}) and pushed to origin/${branch}.`
          : `Synced and pushed to origin/${branch}.`
      };
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /**
   * Spawns a detached background CLI push process so agent hooks never block user turns.
   */
  triggerBackgroundPush(cliEntryPath: string, reason: string): void {
    if (!this.gitCfg.autoPush) return;
    try {
      const child = spawn(process.execPath, [cliEntryPath, "push", "--message", reason, "--quiet"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      // ignore
    }
  }

  /**
   * Manual pull: snapshots dirty local changes, pulls with --rebase,
   * and incrementally reindexes only changed memory files in SQLite.
   */
  manualPull(opts: { pushAfter?: boolean } = {}): PullResult {
    if (!this.isInitialized()) {
      return {
        ok: false,
        updatedFiles: [],
        reindexedCount: 0,
        removedCount: 0,
        hadLocalSnapshot: false,
        message: "Keystone repository is not initialized. Run `keystone init --remote <url>` first."
      };
    }

    const remote = this.getRemoteUrl();
    if (!remote) {
      return {
        ok: false,
        updatedFiles: [],
        reindexedCount: 0,
        removedCount: 0,
        hadLocalSnapshot: false,
        message: "No remote repository bound. Run `keystone bind <remote-url>` first."
      };
    }

    mkdirSync(join(this.repoDir, ".cache"), { recursive: true });
    if (!acquireLock(this.lockPath)) {
      return {
        ok: false,
        updatedFiles: [],
        reindexedCount: 0,
        removedCount: 0,
        hadLocalSnapshot: false,
        message: "Sync lock busy; retry shortly."
      };
    }

    try {
      const branch = this.getCurrentBranch();
      let hadLocalSnapshot = false;

      // 1. Snapshot any uncommitted local memory so rebase is clean
      const dirty = runGit(this.repoDir, ["status", "--porcelain"]);
      if (dirty.ok && dirty.stdout.length > 0) {
        runGit(this.repoDir, ["add", "-A"]);
        const snap = runGit(this.repoDir, [
          "commit",
          "-m",
          `mem(sync): local snapshot before pull from ${hostname()}`
        ]);
        hadLocalSnapshot = snap.ok;
      }

      const prevHead = runGit(this.repoDir, ["rev-parse", "HEAD"]).stdout;

      // 2. Fetch and pull --rebase
      const fetchRes = runGit(this.repoDir, ["fetch", "origin", branch], 25000);
      if (!fetchRes.ok) {
        this.index.setState("last_error", fetchRes.stderr.slice(0, 240));
        return {
          ok: false,
          updatedFiles: [],
          reindexedCount: 0,
          removedCount: 0,
          hadLocalSnapshot,
          message: `Failed to fetch origin/${branch}: ${fetchRes.stderr.slice(0, 200)}`
        };
      }

      const rebaseRes = runGit(this.repoDir, ["rebase", `origin/${branch}`], 25000);
      if (!rebaseRes.ok) {
        // Park local commits safely on a conflict branch rather than losing anything
        const conflictBranch = `conflict/${hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${Date.now()}`;
        runGit(this.repoDir, ["rebase", "--abort"]);
        runGit(this.repoDir, ["branch", conflictBranch]);
        runGit(this.repoDir, ["reset", "--hard", `origin/${branch}`]);

        const full = this.index.fullReindex(this.store);
        this.index.setState("last_error", `Rebase conflict parked at ${conflictBranch}`);
        return {
          ok: false,
          updatedFiles: [],
          reindexedCount: full.indexed,
          removedCount: full.removed,
          hadLocalSnapshot,
          conflictBranch,
          message: `Merge conflict during pull. Local commits preserved on branch '${conflictBranch}', main aligned with origin/${branch} (${full.indexed} memories reindexed).`
        };
      }

      const newHead = runGit(this.repoDir, ["rev-parse", "HEAD"]).stdout;
      let updatedFiles: string[] = [];
      let reindexedCount = 0;
      let removedCount = 0;

      if (prevHead && newHead && prevHead !== newHead) {
        const diffRes = runGit(this.repoDir, ["diff", "--name-only", prevHead, newHead]);
        updatedFiles = diffRes.ok
          ? diffRes.stdout
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const synced = this.index.syncFiles(this.store, updatedFiles);
        reindexedCount = synced.indexed;
        removedCount = synced.removed;
      }

      const now = new Date().toISOString();
      this.index.setState("last_pull_at", now);
      this.index.setState("remote_ahead", "false");
      this.index.setState("last_error", "");

      // Optionally push local rebased commits back if user asked or had local snapshot
      let pushNote = "";
      if (opts.pushAfter && this.gitCfg.autoPush) {
        const p = runGit(this.repoDir, ["push", "-u", "origin", branch], 20000);
        if (p.ok) {
          this.index.setState("push_pending", "false");
          this.index.setState("last_push_at", new Date().toISOString());
          pushNote = " Also pushed rebased local memories.";
        }
      }

      return {
        ok: true,
        updatedFiles,
        reindexedCount,
        removedCount,
        hadLocalSnapshot,
        message:
          updatedFiles.length === 0
            ? `Already up to date with origin/${branch}.${pushNote}`
            : `Pulled ${updatedFiles.length} file(s) from origin/${branch} (+${reindexedCount} indexed, -${removedCount} removed).${pushNote}`
      };
    } finally {
      releaseLock(this.lockPath);
    }
  }

  getSyncStatus(bankId?: string): SyncStatusReport {
    const initialized = this.isInitialized();
    if (!initialized) {
      return {
        repoDir: this.repoDir,
        initialized: false,
        remoteUrl: this.gitCfg.remoteUrl ?? null,
        branch: this.gitCfg.branch,
        headCommit: null,
        dirtyFiles: [],
        ahead: 0,
        behind: 0,
        pushPending: false,
        remoteAhead: false,
        lastPushAt: null,
        lastPullAt: null,
        lastError: null,
        totalIndexedDocs: 0
      };
    }

    const branch = this.getCurrentBranch();
    const remoteUrl = this.getRemoteUrl();
    const headCommit = runGit(this.repoDir, ["rev-parse", "--short", "HEAD"]).stdout || null;
    const statusRes = runGit(this.repoDir, ["status", "--porcelain"]);
    const dirtyFiles = statusRes.ok && statusRes.stdout
      ? statusRes.stdout.split(/\r?\n/).map((l) => l.slice(3).trim()).filter(Boolean)
      : [];

    let ahead = 0;
    let behind = 0;
    const abRes = runGit(this.repoDir, ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`]);
    if (abRes.ok && abRes.stdout) {
      const [a, b] = abRes.stdout.split(/\s+/).map(Number);
      if (!Number.isNaN(a)) ahead = a;
      if (!Number.isNaN(b)) behind = b;
    }

    return {
      repoDir: this.repoDir,
      initialized: true,
      remoteUrl,
      branch,
      headCommit,
      dirtyFiles,
      ahead,
      behind,
      pushPending: this.index.getState("push_pending") === "true" || ahead > 0 || dirtyFiles.length > 0,
      remoteAhead: this.index.getState("remote_ahead") === "true" || behind > 0,
      lastPushAt: this.index.getState("last_push_at"),
      lastPullAt: this.index.getState("last_pull_at"),
      lastError: this.index.getState("last_error") || null,
      totalIndexedDocs: this.index.getTotalCount(),
      bankStats: bankId ? this.index.getBankStats(bankId) : undefined
    };
  }
}

function isNonFastForward(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("non-fast-forward") ||
    lower.includes("fetch first") ||
    lower.includes("rejected") ||
    lower.includes("failed to push some refs")
  );
}

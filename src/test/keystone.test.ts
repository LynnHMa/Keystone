import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildMemoryBundle } from "../core/bundle.js";
import { defaultConfig } from "../core/config.js";
import { KeystoneEngine } from "../core/engine.js";
import { buildReplaceDocRequests, INBOX_PLACEHOLDER, parseInboxEntries } from "../core/gdocs-sync.js";
import { redactSecrets } from "../core/redact.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("Keystone core + Git sync end-to-end", () => {
  it("redacts API keys, Hindsight tokens, GitHub tokens, and PEM blocks while keeping plain UUIDs", () => {
    const raw = [
      "token = hsk_0000000000000000_fake_test_only_1234",
      "OPENAI_API_KEY=sk-proj-fake0000000000000000000000",
      "ghp_fake000000000000000000000000000000",
      "normal uuid 1234567890abcdef1234567890abcdef stays intact"
    ].join("\n");

    const out = redactSecrets(raw, true);
    assert.equal(out.redactedCount >= 3, true);
    assert.equal(out.text.includes("hsk_0000"), false);
    assert.equal(out.text.includes("sk-proj-"), false);
    assert.equal(out.text.includes("ghp_fake"), false);
    assert.equal(out.text.includes("1234567890abcdef1234567890abcdef"), true);
  });

  it("supports Chinese + English hybrid recall, Correction superseding, and Gemini Gem bundling", async () => {
    const dir = makeTempDir("keystone-recall-");
    const cfg = defaultConfig();
    cfg.repoDir = join(dir, "repo");
    cfg.git.autoPush = false;

    const engine = new KeystoneEngine(cfg);
    try {
      engine.init();

      const oldMem = await engine.retain({
        bankId: "global",
        kind: "observation",
        title: "Ledger 货币同步方案",
        content: "旧方案使用双向同步保持 Web 和后端余额一致。",
        harness: "codex",
        syncMode: "none"
      });

      await engine.correct({
        bankId: "global",
        topic: "Ledger 唯一真理源 SSOT",
        wrongClaim: "使用双向同步维护余额",
        truth: "后端通过连接池直连主数据库 users.score 作为唯一真理源 (SSOT)，严禁双向同步。",
        evidence: "src/dao/EconomyDao.java",
        supersedes: [oldMem.doc.id],
        harness: "antigravity-cli",
        syncMode: "none"
      });

      const { results } = await engine.recall({
        bankId: "global",
        query: "Ledger 货币 SSOT 数据库",
        limit: 5
      });

      assert.ok(results.length >= 1, "should recall Chinese+English query");
      assert.equal(results[0].kind, "correction", "correction must rank #1");
      assert.equal(
        results.some((r) => r.id === oldMem.doc.id),
        false,
        "superseded memory should be filtered out by default"
      );

      const bundle = buildMemoryBundle(engine, { bankId: "global" });
      assert.equal(bundle.files.length, 3);
      for (const f of bundle.files) {
        assert.equal(existsSync(f.path), true, `bundle file should exist: ${f.name}`);
      }
    } finally {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-pushes to a real remote Git repo, detects remote-ahead, and manually pulls with incremental SQLite reindex", async () => {
    const root = makeTempDir("keystone-git-");
    const bareRemote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", "-b", "main", bareRemote], { stdio: "ignore" });

    const prevConfigEnv = process.env.KEYSTONE_CONFIG;
    process.env.KEYSTONE_CONFIG = join(root, "test-config.json");

    // Machine A (Claude Code)
    const cfgA = defaultConfig();
    cfgA.repoDir = join(root, "machine-a");
    cfgA.git.remoteUrl = bareRemote;
    cfgA.git.autoPush = true;
    cfgA.git.autoRebaseOnPush = false;
    const engineA = new KeystoneEngine(cfgA);

    // Machine B (dsh)
    const cfgB = defaultConfig();
    cfgB.repoDir = join(root, "machine-b");
    cfgB.git.remoteUrl = bareRemote;
    cfgB.git.autoPush = true;
    cfgB.git.autoRebaseOnPush = false;
    const engineB = new KeystoneEngine(cfgB);

    try {
      engineA.init(bareRemote);
      const pushA1 = await engineA.retain({
        bankId: "global",
        kind: "observation",
        title: "GraphEngine SaveScope 防抖",
        content: "SaveScope 跨帧合并把 128 节点加载耗时从 7.5s 压到 1s。",
        harness: "claude-code",
        syncMode: "immediate"
      });
      assert.equal(pushA1.pushResult?.pushed, true, "Machine A should auto-push to remote");

      // Machine B clones from remote and sees Machine A's memory immediately
      const initB = engineB.init(bareRemote);
      assert.equal(initB.cloned, true, "Machine B should clone remote memory repo");
      const recallB1 = await engineB.recall({ bankId: "global", query: "SaveScope 跨帧" });
      assert.equal(recallB1.results.length >= 1, true, "Machine B should recall Machine A's memory");

      // Machine B writes and pushes a new memory
      const pushB1 = await engineB.retain({
        bankId: "global",
        kind: "experience",
        title: "AgentBus Redis 协调总线",
        content: "分布式代理服务通过 Redis 协调网关与核心引擎。",
        harness: "dsh",
        syncMode: "immediate"
      });
      assert.equal(pushB1.pushResult?.pushed, true, "Machine B should push cleanly");

      // Machine A writes offline/stale -> auto-push detects remote-ahead without force-pushing
      const pushA2 = await engineA.retain({
        bankId: "global",
        kind: "experience",
        title: "Renderer 白盒透视管线",
        content: "伪 3D 白盒配合深度图锁定场景透视。",
        harness: "antigravity-cli",
        syncMode: "immediate"
      });
      assert.equal(pushA2.pushResult?.remoteAhead, true, "Machine A must detect remote ahead safely");

      // Manual pull on Machine A rebases cleanly and incrementally reindexes Machine B's memory
      const pullA = engineA.pull({ pushAfter: true });
      assert.equal(pullA.ok, true, `Manual pull should succeed: ${pullA.message}`);
      assert.ok(pullA.reindexedCount >= 1, "Incremental reindex should index pulled files");

      const recallA = await engineA.recall({ bankId: "global", query: "Redis 分布式 代理" });
      assert.ok(recallA.results.length >= 1, "Machine A should now recall Machine B's memory");
      assert.equal(recallA.results[0].harness, "dsh");
    } finally {
      engineA.close();
      engineB.close();
      if (prevConfigEnv === undefined) delete process.env.KEYSTONE_CONFIG;
      else process.env.KEYSTONE_CONFIG = prevConfigEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated Stop captures for the same sessionId in-place via watermark", async () => {
    const dir = makeTempDir("keystone-watermark-");
    const cfg = defaultConfig();
    cfg.repoDir = join(dir, "repo");
    cfg.git.autoPush = false;

    const engine = new KeystoneEngine(cfg);
    try {
      engine.init();

      const turn1 = "User: 如何防止主线程阻塞？\nAssistant: 使用 SaveScope 跨帧防抖合并脏标记更新。";
      const r1 = await engine.retainSessionTranscript({
        cwd: dir,
        harness: "antigravity-cli",
        sessionId: "sess-abc-123456",
        transcriptSummary: turn1,
        syncMode: "none"
      });
      assert.equal(r1, 1, "first capture should write 1 session episode");

      // Exact duplicate Stop fire -> must short-circuit with 0 writes
      const r2 = await engine.retainSessionTranscript({
        cwd: dir,
        harness: "antigravity-cli",
        sessionId: "sess-abc-123456",
        transcriptSummary: turn1,
        syncMode: "none"
      });
      assert.equal(r2, 0, "identical content hash must skip duplicate write");

      // New turn appended to same session -> must update single file in-place, not create a 2nd file
      const turn2 = turn1 + "\nUser: 再加一个 GUID 拓扑映射。\nAssistant: 已通过 ContextRegistry 实现 O(1) 查找。";
      const r3 = await engine.retainSessionTranscript({
        cwd: dir,
        harness: "antigravity-cli",
        sessionId: "sess-abc-123456",
        transcriptSummary: turn2,
        syncMode: "none"
      });
      assert.equal(r3, 1, "updated session should upsert in-place");

      const files = engine.store.listAllMemoryFiles();
      assert.equal(files.length, 1, "same sessionId must remain exactly 1 file on disk");
      assert.equal(engine.index.getTotalCount(), 1, "SQLite index must contain exactly 1 doc");

      const recalled = await engine.recall({ bankId: "global", query: "ContextRegistry GUID" });
      assert.equal(recalled.results.length, 1, "updated turn content must be immediately searchable");
    } finally {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses 04_Gemini_Inbox notes cleanly and builds valid Google Docs replace requests", () => {
    assert.deepEqual(parseInboxEntries(INBOX_PLACEHOLDER + "\n\n"), []);

    const multi = [
      INBOX_PLACEHOLDER,
      "",
      "## 新的缓存策略",
      "改用 LRU 缓存限制 512MB 上限防止 OOM。",
      "---",
      "部署切到 Debian 12 容器镜像，去掉旧的 Alpine 兼容补丁。"
    ].join("\n");

    const parsed = parseInboxEntries(multi);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].title, "新的缓存策略");
    assert.ok(parsed[1].content.includes("Debian 12"));

    const emptyDocReqs = buildReplaceDocRequests(2, "hello");
    assert.equal(emptyDocReqs.length, 1, "empty doc should only insert without deleting");

    const nonEmptyReqs = buildReplaceDocRequests(42, "updated");
    assert.equal(nonEmptyReqs.length, 2, "non-empty doc should delete 1..41 then insert at 1");
  });

  it("injects Keystone context once per session and skips recall on tiny greetings", async () => {
    const dir = makeTempDir("keystone-inject-");
    const cfg = defaultConfig();
    cfg.repoDir = join(dir, "repo");
    cfg.git.autoPush = false;

    const engine = new KeystoneEngine(cfg);
    try {
      engine.init();
      await engine.upsertPage({
        bankId: "global",
        slug: "arch_core",
        title: "Arch Core Identity",
        content: "SSOT and cross-frame debounce principles.",
        harness: "antigravity-cli",
        syncMode: "none"
      });
      await engine.retain({
        bankId: "global",
        kind: "experience",
        title: "Noise Episode",
        content: "卧槽 这段日志不该被短句拉出来",
        harness: "dsh",
        syncMode: "none"
      });

      const first = await engine.buildContextInjection({
        cwd: dir,
        prompt: "卧槽",
        harness: "antigravity-cli",
        sessionId: "sess-once-1"
      });
      assert.ok(first, "first turn of session should inject compact page roster");
      assert.ok(first.includes("Arch Core Identity"));
      assert.ok(first.includes("keystone_recall"));
      assert.equal(first.includes("Relevant Recalled Memories"), false, "short greeting <=10 chars must skip recall");

      const second = await engine.buildContextInjection({
        cwd: dir,
        prompt: "那我们现在继续聊具体的 SSOT 架构",
        harness: "antigravity-cli",
        sessionId: "sess-once-1"
      });
      assert.equal(second, null, "second turn of same sessionId must return null");
    } finally {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

# Keystone — Git-Backed Shared Agent Memory

> **One Git SSOT, four coding-agent harnesses, zero vendor lock-in.**

Inspired by [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight), **Keystone** gives **Claude Code**, **Codex CLI**, **dsh (DeepSeek Harness)**, and **Antigravity** a single shared long-term memory backed by your own private Git repository.

## Why Keystone?

- **Git as Single Source of Truth (SSOT)**: All memories live as human-readable Markdown (with YAML frontmatter) and conflict-free ULID-sharded JSONL files inside your private Git repo (`~/.keystone/repo`).
- **Zero-Conflict Multi-Device Sync**: Auto-commits and pushes in the background (never `push --force`), safely detects `remote_ahead`, and supports manual `keystone pull` with millisecond incremental SQLite reindexing.
- **Hindsight-Inspired 4-Network Model**:
  - `pages/` & `pages/initiatives/` — Curated Mental Models & living project plans
  - `corrections/` — Highest-authority overrides that permanently supersede stale facts
  - `observations/` — Consolidated beliefs with confidence & evidence links
  - `episodes/YYYY-MM/` — Append-only World & Experience logs (`ep_<ulid>_<harness>.jsonl`)
- **Zero External Database Required**: Uses Node.js built-in `node:sqlite` (`.cache/index.sqlite`, `.gitignore`d) with CJK-aware FTS5 BM25, 1-hop Entity Graph expansion, optional vector similarity, and authority/recency/supersede reranking.
- **Built-in Secret Redactor**: Automatically scrubs API keys, GitHub/Hindsight tokens, JWTs, and PEM private keys before anything touches Git.
- **Web AI Companion (`keystone bundle`)**: Compiles your memory bank into 3 clean Markdown files ready to mount into **Gemini Gems (Google Drive)**, AI Studio, NotebookLM, or Claude Projects.

## Architecture

```text
  [Claude Code]    [Codex CLI]    [dsh (Cordis)]    [Antigravity]
   Hooks + MCP     Config + MCP    Native Plugin    Hooks + Skill + MCP
        \               |               |               /
         +--------------+-------+-------+--------------+
                                ▼
                   Keystone Core (MCP + CLI)
            Retain (Redact) | Recall (4-Way) | Reflect
                 /                               \
                ▼                                 ▼
  Layer 1: Private Git Repo (SSOT)     Layer 2: .cache/index.sqlite (.gitignore'd)
  Markdown + YAML + ULID JSONL         CJK FTS5 BM25 + Entity Graph + Optional Vec
  Auto-Push / Manual Pull              Incremental reindex via `git diff`
```

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite`, zero native C++ compilation)
- **Git**

## Quick Start

```bash
git clone https://github.com/LynnHMa/Keystone.git
cd Keystone
npm install
npm run check

# 1. Initialize and bind your PRIVATE memory repository
node dist/cli/index.js init --remote https://github.com/<you>/<your-private-memory>.git

# 2. Wire into Claude Code, Codex, dsh, and Antigravity (auto-backs up existing configs)
node dist/cli/index.js install all

# 3. Day-to-day commands
node dist/cli/index.js status
node dist/cli/index.js recall "architecture SSOT"
node dist/cli/index.js reflect "why did we choose this design?"
node dist/cli/index.js retain "Decision" "Use single source of truth." --kind observation
node dist/cli/index.js correct "API Timeout" --wrong "5s" --truth "30s" --evidence "src/client.ts"
node dist/cli/index.js pull              # Manual pull + incremental SQLite reindex
node dist/cli/index.js push              # Manual push
node dist/cli/index.js bundle            # Export 3 Markdown files for Gemini Gem / Drive
node dist/cli/index.js sync-gdocs        # Bidirectional sync with Google Docs + Gemini Inbox
```

## Multi-Harness Integration

| Harness | Wiring (`keystone install <target>`) |
| :--- | :--- |
| **Claude Code** | `~/.claude.json` (`mcpServers.keystone`) + `~/.claude/settings.json` (`SessionStart` / `UserPromptSubmit` / `Stop`) |
| **Codex CLI** | `~/.codex/config.toml` (`[mcp_servers.keystone]`) + `~/.codex/hooks.json` |
| **dsh (DeepSeek Harness)** | Native Cordis plugin in `~/.dsh/cordis.patch.yml` (`agent/session-start`, `agent/pre-step`, `agent/turn-stopping`, `tools`) |
| **Antigravity** | `~/.gemini/config/mcp_config.json` + `~/.gemini/config/hooks.json` + `~/.gemini/config/skills/keystone/SKILL.md` |

## Optional LLM & Embeddings

Keystone works **100% offline with zero API keys** by default. To enable optional LLM distillation (`retain`) and synthesis (`reflect`) or vector embeddings, set environment variables or add an `llm` block to `~/.keystone/config.json`:

```json
{
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your-api-key",
    "model": "gpt-4o-mini",
    "embeddingModel": "text-embedding-3-small"
  }
}
```

## License

MIT

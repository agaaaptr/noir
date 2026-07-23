# Noir — Walking Skeleton Design (S0 → S2 → S3)

- **Date:** 2026-07-23
- **Status:** Proposed (awaiting review)
- **Owner:** agaaaptr
- **Spec type:** Implementation design (brainstorm → spec → plan → implement; Noir dogfooding its own SDD)
- **Parent spec:** `docs/specs/2026-07-23-noir-toolkit-design.md` (the blueprint + decision log D1–D10)
- **Branch:** `develop`
- **Slices covered:** S0 (Foundation, subset) · S2 (Daemon + MCP skeleton) · S3 (Claude Code adapter + scaffolder, minimal)

---

## 0. TL;DR

This is Noir's **first buildable slice**: the walking skeleton that proves the integration thesis —
***a host CLI (Claude Code) connects to Noir over MCP and one tool (`noir.host_status`) round-trips*** —
before any single subsystem is deepened (blueprint §10 de-risk principle).

It is **one spec with two acceptance gates**:

- **Gate 1 — stdio round-trip.** Claude Code spawns the Noir MCP server over stdio; `noir.host_status` returns.
- **Gate 2 — daemon-backed (Streamable HTTP).** The *same* handler core also binds Streamable HTTP behind an auto-managed daemon, with graceful FS fallback = Gate 1's in-process stdio path.

Toolchain: **pnpm workspaces + tsup + vitest + Biome + TypeScript (ESM) + GitHub Actions.** MCP SDK: **v2 beta** (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`), stable release expected **2026-07-28**. Four `@noir-ai/*` packages: `core`, `daemon`, `adapters`, `cli`.

---

## 1. Scope

### 1.1 In scope
- pnpm/tsup monorepo with 4 `@noir-ai/*` packages; TS + build + lint + typecheck + CI.
- `.noir/` store (minimal: `NOIR.md`, `config.yml`, `project.id`) as single source of truth; generated root `.mcp.json` + `CLAUDE.md` as pointers.
- `@noir-ai/core` domain types + config schema (zod).
- `@noir-ai/daemon`: MCP server (handler core + stdio binding + Streamable HTTP binding + daemon lifecycle).
- `@noir-ai/adapters`: `HostAdapter` interface + `claude` emitter (`emitMcpConfig`, `emitContext`).
- `@noir-ai/cli`: the `noir` bin, `noir init` scaffolder, `noir mcp serve`, `noir doctor` (stub).
- One MCP tool: `noir.host_status`.
- S0 branding: rebrand the legacy Claude plugin (`ai-toolkit` / `ai-dev-workflow`) to the Noir identity.

### 1.2 Out of scope (deferred — see §9)
`@noir-ai/store` (persistence), `@noir-ai/skills` + compiler, `@noir-ai/model`, `@noir-ai/create`, the SDD workflow engine, context indexing, memory management, the TUI home screen, and all hosts beyond Claude Code. `host_status` needs **no persistence** to round-trip, so the store is not built here.

---

## 2. Decisions locked (from brainstorming)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| WS-1 | Skeleton scope | Two gates in one spec: stdio round-trip → daemon-backed | Sequences Risk #1 (daemon = highest blast radius); proves the thesis (Gate 1) before deepening (Gate 2); honors roadmap v0.x (S0–S2 ends with a daemon). |
| WS-2 | Package granularity | 4 packages: `core`, `daemon`, `adapters`, `cli` | Materializes the adapter seam (the architectural heart, blueprint §5 principle 1) early; merges daemon+mcp per §5.3's allowed merge; defers everything not needed for the round-trip. |
| WS-3 | Toolchain | pnpm + tsup + vitest + Biome + TS (ESM) + GitHub Actions | Modern, fast, minimal-config; vitest DX suits dogfooding TDD; Biome replaces eslint+prettier with one tool. |
| WS-4 | Transport architecture | Shared handler core + two transport bindings (stdio + Streamable HTTP); FS fallback = in-process stdio path | Multi-transport-in-one-server is a documented best practice; makes Gate 1→2 promotion *additive*; folds graceful degradation (principle 5) in for free. |
| WS-5 | MCP SDK | v2 beta (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`), → stable 2026-07-28 | Stable in 5 days; cleaner package split maps onto `@noir-ai/daemon`; no future migration; stdio (Gate 1) is the most stable part of any MCP SDK, so beta risk is minimal in the gate-1 window. |
| WS-6 | Plugin rebrand | Rename legacy plugin as part of S0 branding | Blueprint §10 S0 lists "branding/rename"; the repo is Noir-branded but still ships `ai-dev-workflow`/`ai-toolkit` — fix the identity inconsistency now. |

---

## 3. Monorepo layout

```
noir/
├─ package.json            # root workspace; scripts: build/lint/typecheck/test; bin "noir" → packages/cli
├─ pnpm-workspace.yaml     # packages/*
├─ tsconfig.base.json      # shared strict ESM TS config
├─ biome.json              # lint + format
├─ vitest.config.ts        # root monorepo test runner
├─ LICENSE                 # proposed MIT (truly OSS; blueprint rejects Elastic-2.0)
├─ .github/workflows/ci.yml # install → biome → tsc → tsup → vitest; mac+linux; Node LTS
├─ packages/
│  ├─ core/      # @noir-ai/core
│  ├─ daemon/    # @noir-ai/daemon
│  ├─ adapters/  # @noir-ai/adapters
│  └─ cli/       # @noir-ai/cli  (provides the `noir` bin)
├─ plugins/
│  └─ noir-workflow/        # REBRANDED from ai-dev-workflow (S0 branding; predecessor, reused at S5)
├─ .claude-plugin/marketplace.json   # marketplace "noir", plugin "noir-workflow" (rebranded)
├─ docs/  README.md  AGENTS.md  .gitignore
```

### 3.1 Package responsibilities

| Package | Responsibility | Key deps |
|---|---|---|
| `@noir-ai/core` | Domain types, `config.yml` schema (zod), `.noir/` layout constants, `ProjectId` type + generator, project loader (`loadProjectInfo` reads `.noir/project.id` + `config.yml`); otherwise no I/O. | zod |
| `@noir-ai/daemon` | MCP handler core (tool definitions + handlers) + stdio binding + Streamable HTTP binding + daemon lifecycle manager. | `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, core |
| `@noir-ai/adapters` | `HostAdapter` interface (`emitMcpConfig`, `emitContext`, `install`, `healthCheck`, …) + `claude` emitter. | core |
| `@noir-ai/cli` | The `noir` bin; `noir init` (scaffold `.noir/` + run adapter); `noir mcp serve [--stdio]`; `noir daemon start\|stop`; `noir doctor` (stub). | daemon, adapters, core |

Deferred packages (not materialized, not stubbed): `store`, `skills`, `model`, `create`.

---

## 4. The `.noir/` store (minimal)

`.noir/` is the **single source of truth**. Generated artifacts are **pointers at the repo root**, never copies that drift (blueprint §5 principle 2, §6.5).

```
.noir/
├─ NOIR.md        # canonical context (minimal: project name + a Noir status line)
├─ config.yml     # { host: claude, mode: full|quick, daemon: { idleTimeoutSec, port } } — validated by core zod schema (port optional; default = auto-pick a free 127.0.0.1 port)
└─ project.id     # canonical ProjectId — generated, NOT a filesystem path (D6 / §9.3 anti-footgun)
```

Generated at repo root (idempotent re-emit via marker-comment blocks):
- **`.mcp.json`** — *critical* (this is how Claude Code connects).
- **`CLAUDE.md`** — contains `@import ".noir/NOIR.md"` (zero duplication).

All other `.noir/` subdirectories from blueprint §5.4 (`state/`, `specs/`, `memory/`, `context/`, `skills/`, `agents/`, `commands/`, `hooks/`, `mcp/`) are **deferred** — each appears when its subsystem's slice arrives.

---

## 5. The two gates

### 5.1 The tool: `noir.host_status`
The only tool surface in the skeleton (no args). Returns project + runtime status:
- **Gate 1 (stdio):** `{ noir: <version>, project: { id, name }, host: "claude", transport: "stdio", daemon: false }`
- **Gate 2 (daemon):** `{ …, transport: "streamable-http", daemon: true, pid: <number>, uptimeSec: <number> }`

### 5.2 Gate 1 — stdio round-trip
- `@noir-ai/daemon` builds an MCP server via `@modelcontextprotocol/server` (v2), registers `noir.host_status`, and binds the SDK's **stdio** transport.
- Entry point: `noir mcp serve --stdio` (Claude spawns it). The `--stdio` flag means **force in-process stdio mode** (skip the daemon entirely) — this is Gate 1's mode and also the daemon's FS-fallback path.
- The `claude` adapter emits root `.mcp.json`:
  ```json
  { "mcpServers": { "noir": { "command": "noir", "args": ["mcp", "serve", "--stdio"] } } }
  ```
- `noir init` scaffolds `.noir/` (NOIR.md, config.yml, project.id) then runs the claude adapter to emit `.mcp.json` + `CLAUDE.md`.

**Acceptance — Gate 1:**
- **(a) Automated:** a vitest integration test spawns `noir mcp serve --stdio`, connects with a real MCP client (`@modelcontextprotocol/client`), calls `host_status`, asserts the Gate-1 JSON.
- **(b) Manual (thesis proof):** `noir init` → open Claude Code in the project → invoke the `noir` MCP tool → observe the `host_status` response.

### 5.3 Gate 2 — daemon-backed (Streamable HTTP)
- The **same** handler core additionally binds **Streamable HTTP** via `@modelcontextprotocol/node`.
- A daemon lifecycle manager in `@noir-ai/daemon`:
  - Auto-start on demand (first connect / `noir` invocation).
  - PID + bind metadata under `~/.noir/` (`daemon.pid`, plus the listening `127.0.0.1:<port>`).
  - Idle-stop (graceful shutdown after a configurable idle timeout).
  - Health endpoint: `GET /health`.
  - Graceful shutdown on `SIGTERM`/`SIGINT`.
  - Stale-socket detection + reclaim (PID dead → take over).
- Listens on **localhost TCP** (`127.0.0.1` only), **not** a unix socket — Claude Code's `.mcp.json` `url` transport expects `http(s)://`. (Shared-secret token noted as a security follow-up.)
- **Daemon activation:** a plain HTTP `.mcp.json` only points at a URL, so something must bring the daemon up. For the skeleton, any `noir` invocation runs an `ensureDaemonRunning()` helper that starts-if-down (detached, writes `daemon.pid`); `noir daemon start` / `noir daemon stop` are explicit controls. In the Gate 2 manual demo the user runs `noir` once to bring the daemon up, then Claude Code (HTTP `.mcp.json`) connects to it.
  - **v0 implementation note (2026-07-23 reconciliation):** the shipped skeleton runs a **foreground daemon** — `noir daemon start` blocks in-process, with the http server + idle timer keeping it alive, and the lifecycle record is written to `~/.noir/daemon.json` (pid + port), not `daemon.pid`. The detached / socket-activated lifecycle described above is a **post-v0 refinement**; the foreground shape is sufficient for the Gate 2 round-trip and acceptance.
- **Serve modes (unambiguous):**
  - `noir mcp serve --stdio` → in-process stdio (Gate 1 / FS-fallback). Never touches the daemon.
  - `noir mcp serve` (no flag) → prefer the daemon: connect if up, else start it, else if it cannot start fall back to in-process stdio with a stderr warning. (This is the graceful-degradation story, D7/principle 5/Risk #1, built in from day one.)
  - HTTP `.mcp.json` (Gate 2) → Claude connects to the already-running daemon directly over Streamable HTTP; `noir mcp serve` is not in that path.
- The adapter can also emit an HTTP-based `.mcp.json` for the daemon path:
  ```json
  { "mcpServers": { "noir": { "type": "http", "url": "http://127.0.0.1:<port>/mcp" } } }
  ```

**Acceptance — Gate 2:**
- **(a) Automated:** start daemon → HTTP `host_status` round-trip (`daemon: true`); kill daemon → assert `noir mcp serve` falls back to in-process stdio (degradation test); two clients through one daemon (proves shared state); idle-stop fires after timeout; stale-socket reclaim works.
- **(b) Manual:** with the daemon running, Claude Code (HTTP `.mcp.json`) connects and `host_status` reports `daemon: true`.

---

## 6. S0 branding — legacy plugin rebrand

The repo is Noir-branded but still ships the predecessor Claude plugin under old names. Realign it as a focused S0 task (independent and cheap; can be the first commit on `develop`).

- Directory: `plugins/ai-dev-workflow/` → **`plugins/noir-workflow/`**
- Marketplace (`.claude-plugin/marketplace.json`): `name` `ai-toolkit` → **`noir`**; plugin `name` `ai-dev-workflow` → **`noir-workflow`**; `source` → `./plugins/noir-workflow`; update `description` to the Noir identity.
- Update internal references across the plugin's `SKILL.md` / `references/` / `templates/` and root `README.md` / `AGENTS.md`.

**Names confirmed (2026-07-23 review):** marketplace **`noir`**, plugin **`noir-workflow`**. Used only as a fallback if a name turns out unavailable at impl: marketplace `noir-ai` (mirrors the npm scope `@noir-ai/*`), plugin `noir-skills`.

> Note: the plugin remains a **predecessor / distribution channel** (blueprint §3 non-goal: Claude marketplace retained only as a distribution channel). Its skills are reused as canonical source material at S5. This rebrand is identity consistency, not a functional dependency of the skeleton.

---

## 7. Error handling & degradation

- **stdio logging discipline (real MCP gotcha):** stdout is reserved for JSON-RPC — **all logs go to stderr** (or a file). Implemented from day one.
- Daemon unreachable → in-process stdio fallback + a stderr warning.
- Stale daemon socket (PID dead) → detect on connect, reclaim, restart.
- No `.noir/` (not initialized) → `host_status` returns a clear `"not initialized; run \`noir init\`"` message, not an exception.
- Invalid `config.yml` → fail fast with an actionable zod error (field name + expected value).

---

## 8. Testing & CI

- **Unit:** core config-schema validation; `ProjectId` generation; adapter emitter output (snapshot of generated `.mcp.json` + `CLAUDE.md`).
- **Integration (Gate 1):** stdio server subprocess + real MCP client → `host_status`.
- **Integration (Gate 2):** daemon lifecycle — start, health, HTTP round-trip, idle-stop, stale-socket reclaim, FS-fallback path.
- **CI:** GitHub Actions, macOS + Linux, Node LTS — `pnpm install → biome check → tsc --noEmit → tsup build → vitest`.

---

## 9. Explicitly out of scope (deferred, not abandoned)

| Deferred | Target slice | Why |
|---|---|---|
| `@noir-ai/store` (SQLite/FTS5) | S1 | `host_status` needs no persistence. |
| SDD workflow engine (state machine, gates) | S4 | The differentiator; not needed to prove the MCP thesis. |
| Builtin skills + compiler | S5 | Reuses the rebranded plugin as source. |
| Context management (indexing, `context_search`) | S6 | Needs the store. |
| Memory management | S7 | Needs the store. |
| Bounded model layer | S8 | Optional; degrades to pure orchestration. |
| CLI/TUI home screen | S9 | v1.0 polish. |
| Hosts beyond Claude Code | S10 | v1.x. |

---

## 10. Resolved at review (2026-07-23) vs. verify-at-implementation

**Confirmed / locked at review:**
- Plugin & marketplace names: marketplace **`noir`**, plugin **`noir-workflow`** (fallback only if unavailable: `noir-ai` / `noir-skills`).
- **LICENSE:** **MIT**.
- **Module system:** **ESM** (`"type": "module"`, tsup ESM output) to match the v2 SDK / modern Node.

**Genuine verify-at-implementation (non-blocking):**
- **Namespace availability:** `@noir-ai/*` npm scope + `noir` bin (D10). If `noir` is taken, packages stay scoped; local dev runs via `pnpm noir`.
- **Claude Code `.mcp.json` schema** for the `url`/Streamable-HTTP transport (confirm before Gate 2; Gate 1 uses the stable stdio `command` form).

---

## 11. References (research grounding)

- MCP TypeScript SDK (v2 beta, `@modelcontextprotocol/server` + `/node`; stable 2026-07-28): https://github.com/modelcontextprotocol/typescript-sdk
- MCP Transports spec (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Multi-transport-in-one-server best practice (stdio for local, Streamable HTTP for shared): https://www.truefoundry.com/blog/mcp-stdio-vs-streamable-http-enterprise
- stdio = single-client-per-process vs HTTP = shared state: https://medium.com/@kumaran.isk/dual-transport-mcp-servers-stdio-vs-http-explained-bd8865671e1f
- Daemon/shared-process pattern for MCP (right-sizing): https://www.punt-labs.com/blog/right-sizing-mcp-servers
- MCP server best practices (logging, security): https://snyk.io/articles/5-best-practices-for-building-mcp-servers/
- Node process lifecycle (don't block the event loop): https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop

---

## 12. Next steps

1. **User reviews this spec** (current gate).
2. On approval → invoke the **writing-plans** skill to produce a step-by-step implementation plan (task breakdown for S0 branding → Gate 1 → Gate 2), consumed by the executing-plans / TDD flow.

# Noir — S9 CLI/TUI Home Screen Design (`@noir-ai/cli`)

> **Status: RESOLVED 2026-07-25 — implemented & validated (729/729 tests). OQs resolved per docs/superpowers/plans/2026-07-24-v1.0-execution-plan.md §1.**

- **Date:** 2026-07-24
- **Slice:** S9 — roadmap v1.0 capstone. Depends on S6 (context), S7 (memory), S8 (bounded model) being landed.
- **Parent:** blueprint §6.3 (CLI) + digest §6 (CLI current state) + §10 (S9 research).
- **Grounding:** `.superpowers/sdd/2026-07-24-s6-s9-grounding-digest.md` (authoritative, esp. §4 daemon, §5 config, §6 CLI, §10 S9).

---

## 0. TL;DR

Turn `@noir-ai/cli` from a **hand-rolled `parseArgs` dispatcher** (digest §6: `bin.ts` uses `node:util` `parseArgs`) into an **orchestrator-first home screen + command tree** on a **commander** backbone, with an **optional `@clack/prompts` interactive home menu** that auto-disables in CI / pipes / `--json`. Every sub-command becomes a thin client over **either the daemon (MCP-over-HTTP) or in-process services** — reads always work, writes degrade with an honest message. The daemon stays **foreground-only** (`--detach` is wired but returns "not implemented, tracked v1.x"). A full-screen Ink/blessed TUI is **deferred to v2**.

---

## 1. Objective & problem

**Problem.** The v1 MVP persona (digest §0: "solo power-user doing idea→spec→plan→implementation inside Claude Code") now has S6 context, S7 memory, S8 bounded model, and the S4 workflow engine — but the only way to touch them from a shell is a flat, hand-rolled dispatcher (`init`, `sync`, `mcp serve`, `daemon start|stop`, `doctor`) with **no command tree, no `--help` story, no stable exit codes, no scriptable JSON, and no interactive entry point**. As the slice that integrates everything, the CLI is the natural home screen.

**Objective.** Ship the v1.0 CLI surface:

1. **Commander backbone** replacing `parseArgs` — nested subcommands, generated `--help`, `exitOverride` for testability.
2. **Interactive home menu** (`@clack/prompts`) gated on `isTTY && !noInput` — the "home screen" when a human runs bare `noir`.
3. **Scriptable non-interactive mode** — global `--json --no-input --quiet --verbose --cwd`, exit codes `0/1/2/3/4/5`, data→stdout / diagnostics→stderr.
4. **Honest foreground daemon UX** — never silently fork.
5. **Wiring** of `status/context/memory/skills/task/daemon/doctor` sub-commands to the daemon MCP transport or in-process fallback.
6. **Behavior-preserving migration** of existing `init/sync/mcp/daemon/doctor` onto commander.

---

## 2. Decisions (drafted; OQ-1..6 for review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | v1 CLI ambition | **commander + optional `@clack/prompts` home menu**; full-screen Ink/blessed TUI deferred to v2 | Digest §10: "command-tree backbone + optional @clack menu gated on `isTTY && !noInput`. Defer full-screen Ink/blessed TUI to v2." Ink pulls React + a renderer + bundle weight Noir forbids for a v1 bin (blueprint §9: adopt ideas natively, don't import sprawl). |
| DS-2 | Dispatcher | **Replace hand-rolled `parseArgs` with `commander`** | §6: current dispatcher is hand-rolled `node:util` `parseArgs` in `bin.ts`. It does not scale to the §10 nested command tree (3-level: `noir memory recall`), has no `--help` generation, and no testable exit hook. Commander's `exitOverride` + `parseAsync` make the CLI unit-testable without `process.exit`. |
| DS-3 | Interactive home menu | **`@clack/prompts`, gated on `isTTY && !noInput && !--json`** | §10. `@clack` is composable (not full-screen), ~no deps, degrades to plain subcommands in CI/pipes. Bare `noir` in a TTY shows the menu; bare `noir` in CI behaves like `noir status --json`. |
| DS-4 | Global flags + stream discipline + exit codes | **`--json --no-input --quiet --verbose --cwd <path>`; data→stdout, diagnostics→stderr; exit `0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down · 5 cancelled`; via `exitOverride`** | §10 verbatim. Honors `NO_COLOR` / `CI` / `!isTTY`. Stable exit codes make the CLI scriptable and let the host (Claude Code) branch on daemon-down (4) vs usage (2). |
| DS-5 | Execution mode | **Dual: daemon-MCP-if-up, else in-process fallback** | §2 (readonly fallback keeps reads working) + §4 (stateless Streamable HTTP on 127.0.0.1). Read sub-commands (`status`, `context search`, `memory recall`, `skills list`) always work in-process. Write sub-commands (`task new/advance`, `context index`, `memory save`, `memory consolidate`) route through the daemon when its record (`~/.noir/daemon.json`) is live; if down, the CLI opens the store RW **in-process for the command's lifetime** (solo-user MVP) and prints a one-line note. If a second writer is detected, opens readonly and the write throws the §2 `"store is read-only (daemon down)"` message. |
| DS-6 | Daemon-control UX | **Foreground-honest; `--detach` → "not implemented (tracked: v1.x)" exit 2** | §4 (foreground-only is deliberate v0 debt) + §10. `noir daemon start` runs in the foreground, prints `"foreground mode (backgrounding deferred); Ctrl+C to stop"`. Never silently fork. `status` reports pid/uptime/mode or `"not running"` (exit 4). |
| DS-7 | Output deps | **picocolors + cli-table3 + ora; auto-disable under `--json` / non-TTY / `NO_COLOR` / `CI`** | §10 ("lean, Windows-safe"). Suppress spinner + tables under `--json` (machine-readable output must be pristine). All three are isTTY-aware, cross-platform, no native deps. |
| DS-8 | Migration | **Behavior-preserving**: existing `init/sync/mcp/daemon/doctor` reimplemented on commander with identical flags, outputs, and exit behavior | §6 lists the current command set. Migration is refactor-only — no user-visible behavior change, guarded by a before/after fixture snapshot of `--help` + exit codes. |
| DS-9 | Command tree | **Per §10** (see §7 below) | The tree is the integration surface for S4/S5/S6/S7/S8. Concrete names + flags fixed now so skills, docs, and host config can reference them. |

---

## 3. Scope

### 3.1 In scope
- `@noir-ai/cli` rewrite onto commander (replacing `bin.ts` `parseArgs`).
- Optional `@clack/prompts` interactive home menu (TTY-gated).
- Global flags, exit-code contract, stdout/stderr discipline.
- Command tree per §7: `status`, `context`, `memory`, `skills`, `task`, `daemon`, `doctor`, plus migrated `init`, `sync`, `mcp serve`.
- Dual execution mode (daemon-if-up / in-process fallback).
- Foreground daemon UX with `--detach` stub.
- Lean output deps (picocolors, cli-table3, ora).

### 3.2 Out of scope (deferred)
- **Full-screen Ink/blessed TUI** (mouse, splits, panes, persistent repl) — v2. *(OQ-1)*
- **Backgrounded / detached / socket-activated daemon** — v1.x (digest §9 v0 debt).
- **Mouse / split-pane / mouse-driven interactive UI** — v2.
- **`noir` / `noir-home` power skills** (host-side skills that launch the CLI home) — S11 authoring; S9 ships the CLI surface only. *(OQ-5)*
- **OS keychain / secrets in config** — follows S8's env-var stance.
- **Non-Claude host wiring** — S10.

---

## 4. Functional requirements

- **F1** Bare `noir` in a TTY → interactive home menu (status snapshot + quick links to `status/context/memory/skills/task/daemon/doctor`). Bare `noir` in CI / `--json` / `--no-input` → behaves as `noir status` (human) or `noir status --json` (machine).
- **F2** `noir status [--json]` reports: project id, mode, daemon pid/uptime/mode, active workflow task id + phase (or none), store status (`ok`/`degraded`), counts (docs/vecs/memories). **Probe-only (amended post-review):** `status` NEVER auto-starts a daemon — it probes `~/.noir/daemon.json` + pid + `GET /health` and reports `daemon:{running:false}` with **exit 0** when down (status is informational; a down daemon is not an error). Project id/name/host/version are read in-process; the count tools are fetched over the running daemon only when the probe succeeds (one connection, never starts one). Active read/write commands (`context *`, `memory *`, `task *`) still start/require the daemon for v1 — in-process read fallback is deferred to v1.x (DS-5); their daemon-down path is the exit-4 `{ok:false,error:{code:4,message}}` envelope.
- **F3** `noir context {search,index,status}` — wires to S6 hybrid engine. `search <query> [--limit N] [--json]`; `index [--path …] [--force]`; `status` (index freshness / counts).
- **F4** `noir memory {recall,save,sessions,forget,consolidate}` — wires to S7. `recall <query>`; `save --content … --type …`; `sessions`; `forget <id>`; `consolidate` (provider-explicit; refuses with a clear message if no provider configured — S8 rule).
- **F5** `noir skills {list,sync}` — wires to S5 compiler. `list` (installed builtin pack); `sync` (re-emit to host skills dir).
- **F6** `noir task {new,status,advance,next}` — wires to S4 workflow + S8 drafting. `new --slug … [--mode full|quick]`; `status`; `advance [--to …]`; `next` (suggests next phase + applicable skill).
- **F7** `noir daemon {start,stop,status,restart}` — `start` foreground; `--detach` → exit 2 "not implemented"; `stop` (sends signal to pid in `daemon.json`); `status`; `restart`.
- **F8** `noir doctor` — environment / project health (node, pnpm, deps, config validity, daemon reachability, store openability, embedding model presence for S6).
- **F9** Migrated `noir init [--transport stdio|streamable-http]`, `noir sync`, `noir mcp serve [--stdio]` — flag-for-flag compatible with §6 current behavior.
- **F10** Global flags honored by every command: `--json`, `--no-input`, `--quiet`, `--verbose`, `--cwd <path>`. `NO_COLOR` / `CI` / `!isTTY` implicitly engage non-interactive mode.
- **F11** Exit codes per DS-4. `--json` output is a stable, versioned schema (`{ok, data, error?, warnings?}`).

---

## 5. Non-functional requirements

- **NF1 Scriptable.** Stable flags + stable `--json` schema + stable exit codes across v1.x. `--help` output is snapshot-tested (no undocumented renames).
- **NF2 Windows-safe.** No shell-isms, no `/dev/tty` assumptions, no ANSI-without-isTTY. All output deps are cross-platform. `--cwd` accepts Windows paths.
- **NF3 Lean deps.** Runtime additions capped at **5** (`commander`, `@clack/prompts`, `picocolors`, `cli-table3`, `ora`) — all pure JS, no native bindings, ESM/CJS clean under tsup.
- **NF4 Testable.** Commander `exitOverride` + dependency injection of the daemon-client / in-process-services means unit tests never call `process.exit` and never start a real daemon.
- **NF5 Honest.** No silent forks, no silent paid LLM calls (S8), no silent network. Every degradation prints a one-line stderr note + a stable exit code.
- **NF6 Fast cold-start.** Lazy-import heavy paths (S6 embeddings, S8 model adapters) so `noir status` stays sub-100ms when the daemon is up.

---

## 6. Architecture

```
@noir-ai/cli
├─ bin.ts                   # shebang → program.parseAsync(argv)  (REPLACES parseArgs dispatcher)
├─ program.ts               # commander Program + global flags + exitOverride wiring
├─ home.ts                  # @clack/prompts home menu (TTY-gated; no-op in CI)
├─ commands/
│  ├─ status.ts             # aggregates daemon + workflow + store snapshot
│  ├─ context/              # search | index | status   → S6
│  ├─ memory/               # recall | save | sessions | forget | consolidate  → S7
│  ├─ skills/               # list | sync               → S5
│  ├─ task/                 # new | status | advance | next  → S4 + S8
│  ├─ daemon/               # start | stop | status | restart  → @noir-ai/daemon
│  ├─ doctor.ts
│  ├─ init.ts  sync.ts  mcp.ts    # migrated, behavior-preserving
│  └─ _shared/              # output.ts (picocolors/cli-table3/ora), streams.ts, exit.ts
├─ runtime/
│  ├─ daemonClient.ts       # MCP-over-HTTP client to 127.0.0.1:<port> (reads daemon.json)
│  └─ inProcess.ts          # opens @noir-ai/store (readonly-safe) + WorkflowEngine + S8 complete()
└─ index.ts
```

**Key flows.**

- **Dispatch.** `bin.ts` builds the commander program (DS-2), wires `exitOverride` → custom exit-code mapper (DS-4), and registers all subcommands. If `argv` has no command AND `isTTY && !noInput && !--json` → delegate to `home.ts`; otherwise default to `status`.
- **Dual mode (DS-5).** Each command resolves a `Runtime` handle: try `daemonClient` (read `~/.noir/daemon.json`, ping port); on failure fall back to `inProcess` (open store readonly; for writes, attempt RW only if no live daemon record). Commands declare their read/write need; the runtime enforces it.
- **Streams.** `output.ts` centralizes picocolors/table/ora and force-disables them under `--json` / `NO_COLOR` / `CI` / `!isTTY`. Data payloads go to `stdout`; everything else (progress, warnings, errors) to `stderr`.
- **Daemon start.** `daemon start` imports `createNoirServer` + `StdioServerTransport`/`StreamableHTTPServerTransport` from `@noir-ai/daemon` (§4), writes `daemon.json`, and **blocks** in the foreground until SIGINT.

---

## 7. Command tree (digest §10)

| Command | Flags | Wires to | Mode |
|---|---|---|---|
| `noir` | — | home menu (TTY) / `status` (non-TTY) | interactive |
| `noir status` | `[--json]` | daemon + store + workflow | read (dual) |
| `noir context search` | `<query> [--limit N] [--json]` | S6 engine | read (dual) |
| `noir context index` | `[--path …] [--force]` | S6 indexer | write (daemon) |
| `noir context status` | `[--json]` | S6 counts/freshness | read (dual) |
| `noir memory recall` | `<query> [--limit N] [--json]` | S7 (S6 engine) | read (dual) |
| `noir memory save` | `--content … --type … [--files …]` | S7 | write (daemon) |
| `noir memory sessions` | `[--json]` | S7 | read (dual) |
| `noir memory forget` | `<id>` | S7 | write (daemon) |
| `noir memory consolidate` | `[--provider …]` | S7 + S8 (provider-explicit) | write (daemon) |
| `noir skills list` | `[--json]` | S5 compiler `discoverBuiltin()` | read (in-process) |
| `noir skills sync` | — | S5 compiler `emitSkillsToDir` via adapter | write (host fs) |
| `noir task new` | `--slug … [--mode full\|quick]` | S4 workflow | write (daemon) |
| `noir task status` | `[--json]` | S4 | read (dual) |
| `noir task advance` | `[--to …] [--force reason…]` | S4 (+ S8 drafting in `spec`/`plan`) | write (daemon) |
| `noir task next` | `[--json]` | S4 + skill suggestion | read (dual) |
| `noir daemon start` | `[--detach]` | `@noir-ai/daemon` | foreground; `--detach`→exit 2 |
| `noir daemon stop` | — | signal pid from `daemon.json` | write |
| `noir daemon status` | `[--json]` | `daemon.json` + ping | read; "not running"→exit 4 |
| `noir daemon restart` | — | stop + start | write |
| `noir doctor` | `[--json]` | env + config + daemon + store | read |
| `noir init` | `[--transport stdio\|streamable-http]` | adapter `emitMcpConfig` + skills | write (host fs) |
| `noir sync` | — | adapter emit + S5 skills | write (host fs) |
| `noir mcp serve` | `[--stdio]` | `@noir-ai/daemon` stdio server | foreground |

---

## 8. Daemon-control UX (foreground honesty)

- `noir daemon start` prints, then **blocks**:
  > `noir daemon: foreground mode (backgrounding deferred to v1.x). Ctrl+C to stop.`
  On SIGINT: flush, close store, delete `daemon.json`, exit 0.
- `noir daemon start --detach` → stderr `not implemented (tracked: v1.x)` + **exit 2**. The flag is wired (documented in `--help`) but refuses, so users scripting against it get a stable, honest failure instead of a surprise fork.
- `noir daemon status` → `{pid, port, startedAt, uptimeSec, mode: "foreground"}` or `not running` (**exit 4**). A stale `daemon.json` (pid dead) is detected and reported as `not running (stale record removed)`.
- `noir daemon stop` → sends SIGTERM to the recorded pid; reports success/failure; removes `daemon.json`.
- No auth token on the HTTP transport in v1 (digest §9 v0 debt — recorded, not fixed in S9).

---

## 9. Output dependencies

| Dep | Use | Auto-disable rule |
|---|---|---|
| `commander` | program + subcommands + `--help` + `exitOverride` | never (core) |
| `@clack/prompts` | interactive home menu | `!isTTY \|\| noInput \|\| --json` |
| `picocolors` | ANSI colors | `NO_COLOR \|\| CI \|\| !isTTY \|\| --json` |
| `cli-table3` | human tables (`status`, `skills list`, `memory sessions`) | `--json` (machine output is pristine JSON arrays) |
| `ora` | spinners for long ops (`context index`, `memory consolidate`) | `!isTTY \|\| CI \|\| --json \|\| --quiet` |

All five are pure-JS, cross-platform, ESM/CJS interoperable, no native bindings — consistent with the toolchain (digest §1: TS ESM, tsup, Node ≥20).

---

## 10. Migration plan (existing commands → commander, behavior-preserving)

1. **Snapshot current behavior.** Capture `--help` text + exit codes + stdout/stderr split for `init`, `sync`, `mcp serve`, `daemon start|stop`, `doctor` (current `parseArgs` dispatcher).
2. **Port each command** onto a commander subcommand; route args through commander's parsed options instead of `parseArgs({ args, allowNegative: true, … })`.
3. **Preserve messaging.** §6: `init`/`sync` run in-process, **stderr-only** human messaging — keep that; only the dispatch path changes.
4. **Re-snapshot** and diff against step 1; any divergence is a bug.
5. **Remove** the `parseArgs` dispatcher from `bin.ts` once all five are ported and green.

Migration is a **refactor**, not a redesign. No flags are renamed, no outputs change, no exit codes shift (existing commands keep exit 0/1).

---

## 11. Dependencies

**Add to `@noir-ai/cli` `package.json`:**
- `commander` (^12)
- `@clack/prompts` (^0.7)
- `picocolors` (^1)
- `cli-table3` (^0.6)
- `ora` (^8, ESM — already matches the ESM-only toolchain)

All are dev + runtime; no native build steps; compatible with `pnpm.onlyBuiltDependencies` constraints (digest §1).

---

## 12. Assumptions *(flagged — confirm in review)*

- **A1 *(assumption)*** The solo-user MVP tolerates the CLI opening the store RW in-process when no daemon is live (DS-5). If the user runs two CLIs concurrently, last-writer semantics apply. *Confirm this is acceptable for v1.*
- **A2 *(assumption)*** `~/.noir/daemon.json` singleton (digest §9) remains acceptable for v1 — concurrent-project clobber is known v0 debt, not fixed in S9.
- **A3 *(assumption)*** The `--json` schema (`{ok, data, error?, warnings?}`) is versioned informally (v1) without a `/v2` URL or Accept-header negotiation.
- **A4 *(assumption)*** S6/S7/S8 land with callable TS APIs (not just MCP tools) so the CLI's in-process fallback can import them directly.

---

## 13. Risks

- **R1 Commander migration regressions.** Mitigation: snapshot/diff (§10 step 4) + behavior-preserving fixture suite.
- **R2 Exit-code consumer confusion** (5 codes is more than POSIX minimal). Mitigation: `--help` documents all five; `--json` always includes a stable `error.code`.
- **R3 Daemon / single-writer concurrency** when CLI writes in-process while a daemon is also live. Mitigation: DS-5 "detect live daemon → route through it"; pid-liveness check.
- **R4 `@clack` in constrained terminals** (VS Code integrated terminal, SSH, Windows ConHost). Mitigation: TTY-gate + auto-fallback to `status`.
- **R5 Cold-start weight** if S6 embeddings / S8 adapters are eagerly imported. Mitigation: NF6 lazy imports.
- **R6 ora ESM-only** under tsup ESM build — verify `import ora from 'ora'` resolves cleanly.

---

## 14. Alternatives considered

- **Ink / blessed full-screen TUI (v2).** Rejected for v1: React + renderer + bundle cost (blueprint §9: don't import sprawl); mouse/splits/repl add surface area without clear MVP payoff; `@clack` composable menu covers the "home screen" need at a fraction of the weight. Deferred to v2 (DS-1, OQ-1).
- **`citty` instead of `commander`.** Smaller, but commander's mature `--help` generation, nested subcommand handling, and `exitOverride` testability outweigh the size difference for a 3-level command tree.
- **`oclif`** — plugin/ecoystem framework; too heavy for a monorepo bin with a fixed command set.
- **Keep `parseArgs`, add a thin router.** Rejected (DS-2): the router reimplements commander poorly; `--help`, exit codes, and testability all suffer.
- **Backgrounded daemon in S9.** Rejected (§3.2, DS-6): foreground-only is deliberate v0 debt (§9); `--detach` is stubbed honestly.

---

## 15. Open questions (recommended default each; ⚡ = gating)

- **OQ-1 ⚡ (gating) TUI ambition.** commander + `@clack` home menu **[recommended]** vs full Ink/blessed TUI in v1.
  *Default:* commander + `@clack`; defer Ink to v2.
- **OQ-2 ⚡ (gating) Migrate dispatcher → commander now.** Migrate now **[recommended]** vs keep hand-rolled `parseArgs` and bolt on.
  *Default:* migrate now (S9 is the capstone; `parseArgs` won't carry the §10 tree).
- **OQ-3 Interactive home menu in v1.** Include, TTY-gated **[recommended]** vs defer to v1.x.
  *Default:* include; auto-disable in CI/`--json`.
- **OQ-4 Daemon-control scope.** Full `start/stop/status/restart` with foreground honesty **[recommended]** vs status-only (read-only) in v1.
  *Default:* full control; `--detach` stubbed exit 2.
- **OQ-5 `noir` / `noir-home` power skills.** Add host-side skills that launch the CLI home in S9 **vs** defer skill authoring to S11.
  *Default:* **defer** — S9 ships the CLI surface only; a `noir-home` skill (if wanted) is an S11 authoring task.
- **OQ-6 Exit-code contract.** Adopt `0/1/2/3/4/5` **[recommended]** vs simplify to `0/1`.
  *Default:* adopt the full contract (scriptable; daemon-down distinguishable for the host).

---

## 16. Testing & CI

- **Commander testability.** `exitOverride` + `parseAsync(Array, { from: 'user' })` lets unit tests invoke any subcommand and capture exit code + stdout/stderr without `process.exit` killing the runner.
- **No real daemon in unit tests.** `daemonClient` is injectable (mock the HTTP ping); `inProcess` services are mocked at the `@noir-ai/store` / `workflow` / `skills` boundary. Integration tests that need a daemon spin it on an ephemeral port with `NOIR_DAEMON_JSON` override (§4).
- **Non-interactive assertions.** Every command has a `--json` test (schema `{ok,data,error?,warnings?}`) and a `!isTTY` test (no spinner, no color, exit code correct).
- **Exit-code matrix.** One test per code: 0 ok, 1 error, 2 usage (`--detach`), 3 not-found (unknown subcommand), 4 daemon-down (`daemon status` when absent), 5 cancelled (`@clack` abort).
- **Migration snapshot.** §10 step 1 snapshot re-asserted post-port.
- **TTY-gate.** `home.ts` tested under forced TTY and forced non-TTY.
- **Full suite offline.** No network, no real embeddings download, no provider keys (S8 rule).

---

## 17. Acceptance criteria

1. `noir` in a TTY shows the `@clack` home menu; in CI / `--json` behaves as `noir status [--json]`.
2. All §7 commands dispatch, return correct exit codes (DS-4), and split data/diagnostics correctly.
3. `--json` output matches the versioned schema for every command.
4. Migrated `init/sync/mcp/daemon/doctor` pass the §10 behavior snapshot (zero diff).
5. `noir daemon start` blocks foreground with the honest message; `--detach` exits 2.
6. `noir status` works daemon-down (probe-only — reports `daemon:{running:false}` + exit 0, NEVER auto-starts). Active read/write sub-commands (`context *`, `memory *`, `task *`) start/require the daemon for v1 (in-process read fallback deferred to v1.x / DS-5); their daemon-down path is the exit-4 envelope.
7. All output deps auto-disable under `--json` / `NO_COLOR` / `CI` / `!isTTY`.

---

## 18. Definition of Done

- S9 spec reviewed, OQ-1..6 resolved.
- `@noir-ai/cli` on commander; `parseArgs` dispatcher removed.
- §7 command tree implemented and wired to S4/S5/S6/S7/S8 + daemon.
- Exit-code + `--json` + stream-discipline tests green (incl. non-TTY).
- Migration snapshot clean.
- `pnpm lint` + `pnpm test` green on ubuntu + macos, Node 22 (digest §1 CI matrix).
- `noir doctor` reports the new CLI surface.
- Roadmap (§0 S9 milestone) marked done; this spec's status flipped to **Reviewed**.

---

## 19. References

- Digest: `.superpowers/sdd/2026-07-24-s6-s9-grounding-digest.md` §4 (daemon), §5 (config), §6 (CLI current state), §10 (S9 research).
- Sibling spec: `docs/superpowers/specs/2026-07-24-s5-skills-design.md` (structure + DS/OQ format).
- [commander](https://github.com/tj/commander.js) · [@clack/prompts](https://github.com/bombshell-dev/clack) · [picocolors](https://github.com/alexeyraspopov/picocolors) · [cli-table3](https://github.com/cli-table/cli-table3) · [ora](https://github.com/sindresorhus/ora).
- Blueprint §6.3 (CLI), §9 (adopt natively, don't import sprawl).

---

## 20. Next steps

1. **User reviews this draft** — resolve OQ-1..OQ-6 (⚡ OQ-1, OQ-2 are the hard gates).
2. On approval → **writing-plans** → subagent-driven implementation (implementer + reviewer, sonnet) → final opus whole-branch review → 1 fix wave (digest §1 SDD dogfood).

# ADR-0003: v1.x capabilities — keystone refactor + five extensions

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

v1.0 shipped a release-ready baseline (slices S0–S9): the daemon, the single MCP server, the SDD workflow FSM, native context + memory, the bounded model layer, and the 31-skill native pack. Five follow-on capabilities were deferred to "v1.x" because they were independently valuable but each risked touching the same host-facing surfaces (`.noir/`, `CLAUDE.md`, the skill namespace, the MCP tool list) — doing them as five unrelated patches would have produced five different ways to manage a managed block, five different idempotency stories, and five different integration shapes.

The deferred capabilities were:

- **R** — a Noir-curated rules seed wired into the host, addressable as a single source of truth.
- **I** — idempotent, multi-file ignore management (`.gitignore`, `.dockerignore`, `.npmignore`, `.prettierignore`) so re-running `noir init`/`sync` neither rots nor duplicates managed entries.
- **P** — a PRD artifact kind (and a soft gate) so product specs become a first-class Noir artifact alongside specs/plans.
- **S** — a real scaffold engine: declarative manifest, templates, `.noir/scaffold-version`, migrations — graduating init/sync from inline string concatenation in the CLI to a shared, tested subsystem.
- **X** — a first-class integration layer; ClickUp as the first integration, with skill-only + write-proxy + full-runtime tiers.

The forced question was: in what order, with what shared foundation, and under what integration model?

## Decision

**One keystone refactor, then five sequential extensions through the seam it introduces.**

### K — the keystone (pure refactor, no behavior change)

A single `managedBlock(name, commentStyle)` factory + a shared block-region writer (`writeManagedRegion` / `readManagedBlock` / `stripManagedBlock` / `commentStyleFor`) + a `HostAdapter.emitRules` seam. Every later slice writes a managed block through this one writer instead of each slice rolling its own. K is a pure refactor: it changes no user-visible behavior, it only relocates the existing `CLAUDE.md`-block logic into a reusable shape and adds the rules seam.

### R / I / P / S / X — five extensions, sequenced

The slices are run **sequentially** (K → R → I → P → S → X), not in parallel. Each one consumes the keystone seam and is reviewed and merged before the next begins, so the managed-block contract is stressed by one consumer at a time and the writer stays honest. The sequence is also dependency-ordered: Rules owns `RULES.md` and the `RULES_BLOCK` before Scaffold rewrites init/sync to consume the new engine, and before Integration emits its own skill + config + MCP tool shape.

- **R** — a single `.noir/rules/RULES.md` Noir-curated seed, wired into `CLAUDE.md` via a managed `RULES_BLOCK`; `noir-rules` skill. One rules file, not per-skill or per-package.
- **I** — `IgnoreManager` + `syncIgnores` into init/sync, using the keystone writer so the four supported ignore files stay idempotent across re-runs.
- **P** — `prd` artifact kind + `writePrd`/`readPrd` + `noir-prd` skill, behind a soft PRD gate. **No FSM change** and **explicit opt-in** — PRD does not reshape the lifecycle.
- **S** — a **new package** `@noir-ai/create` (the three-mode writer `regenerate`/`managedBlock`/`skipIfExists` generalizes the keystone writer; declarative manifest; hand-rolled `{{var}}` templates; `.noir/scaffold-version`; inline-conflict migrations; read-only stack-detect). CLI: `noir init`/`sync` consume the engine; **`noir create [dir]` is AI-layer-only** — it drops `.noir/` + skills + host wiring without touching the rest of the project; `noir init --upgrade` runs migrations; `noir doctor` checks scaffold-version drift.
- **X** — first-class integration layer. **Three runtime tiers** (`skill-only` default / `gated-write-proxy` / `full-runtime`), all declared in each integration's `integration.json` and honored at registration. First integration: **ClickUp**, at the `gated-write-proxy` tier.

### ClickUp integration — the 3-tier model + 2-way sync

An integration declares one of three runtimes:

1. **`skill-only`** (default) — the integration ships a `noir-<name>` skill + `references/`. No MCP tool, no proxy. The host does all the work through the skill.
2. **`gated-write-proxy`** — the skill PLUS a daemon-exposed MCP tool (`<integration>.<verb>`, e.g. `noir.clickup_write`) that performs writes through a **HARD confirm gate**: dry-run → confirm → POST. Endpoint allowlist, id-charset validation, 429 `X-RateLimit-Reset` backoff, audit JSONL.
3. **`full-runtime`** — the integration owns its own runtime (reserved; no v1.x integration uses it).

ClickUp is delivered `skill-only + gated-write-proxy`. **2-way sync is at `/wrap` only** (no standalone `noir clickup sync` for v1.x). OAuth is **refused until a keychain-backed secret store exists** — the only accepted credential path in v1.x is a personal API token resolved from an env-var at call time via the `integrations_auth` MCP tool (which kills the non-interactive-shell gotcha where the host's shell can't see the user's interactive shell env).

### `@noir-ai/create` is a new package, not a cli-internal module

Scaffold graduated from an inline CLI concern to a subsystem with its own public API, its own consumers (`noir init`, `noir sync`, `noir create`, `noir doctor`), its own versioned output (`.noir/scaffold-version`), and its own migration contract. Per [ADR-0002](0002-native-skills-only-plugin-removed.md) and the [packaging guide](../how-to/packaging.md) ("add a package only for a genuinely new subsystem/domain"), that is the bar for a new package, so `@noir-ai/create` is its own package. `noir create [dir]` is constrained to the **AI layer only** — it never writes outside `.noir/`, the skills directory, and the host wiring; it is not a project generator.

### Locked Open Questions

These were resolved during v1.x and are part of the decision (not just the implementation):

- **Sequential slices, not parallel.** K → R → I → P → S → X. One consumer of the keystone seam at a time.
- **One rules file.** A single `.noir/rules/RULES.md`, not per-skill or per-package rules.
- **ClickUp is `skill-only + gated-write-proxy` + 2-way sync at `/wrap`.** No full-runtime tier, no standalone `noir clickup sync` command.
- **Refuse OAuth until keychain.** The credential surface in v1.x is a single personal API token resolved from an env-var at call time.
- **A new `@noir-ai/create` package** (not a cli-internal module).
- **`noir create [dir]` is AI-layer-only** — never a project generator.

### Doctrine stance (reaffirmed, not new)

These pre-date v1.x but are load-bearing for every slice above and were used as the acceptance bar:

- **Adopt ideas, not copies.** The predecessor `noir-workflow` plugin and the various third-party plugins (Superpowers, context-mode, agentmemory) are *reference material*, not code to vendor. Slice X reintroduces ClickUp as a first-class Noir integration written from scratch — and the residue guard's ClickUp ban was lifted only because the new code is an original Noir re-implementation, not a port.
- **Graceful degradation everywhere.** No key → pure orchestration. Daemon down → read-only store. Missing integration config → the integration is unregistered, never half-registered.
- **No silent writes.** Every write path either is gated behind an explicit confirm (`noir.clickup_write`) or is a managed-block region the user can read and strip. There is no integration that writes to an external system on its own initiative.

## Consequences

- **One managed-block writer, five consumers.** R, I, P, S, and the existing `CLAUDE.md` @import all go through the keystone writer. Adding a sixth managed region is an authoring concern, not an architecture decision.
- **The skill pack grows by integration, not by editing.** `discoverAll()` emits builtins + integrations; adding an integration is `packages/skills/integrations/<name>/` + an `integration.json`, not a CLI change. Pack now 34 (33 builtins + 1 integration).
- **`@noir-ai/create` is the scaffold authority.** Init, sync, create, and the scaffold-version drift check in `noir doctor` all consume one engine. Migrations are registered, inline-conflict-marked, and CI-safe; a broken migration does not silently mangle a user tree.
- **ClickUp writes are observable by construction.** The HARD confirm gate, the endpoint allowlist, and the audit JSONL together make every external write inspectable and replayable. The credential is resolved at call time only, never logged, and canary-tested on success and error paths.
- **OAuth is deferred, deliberately.** Until a keychain-backed secret store exists, ClickUp stays at "personal token in an env-var". The decision is reversible when keychain lands; the runtime tiers and the `gated-write-proxy` shape do not change.
- **`noir create` will not grow into a Yeoman.** The AI-layer-only constraint is binding: scaffolding beyond `.noir/` + skills + host wiring is out of scope and should be flagged in review, not merged.

## References

- Full design record: [`specs/2026-07-25-v1x-capabilities-design.md`](../internal/specs/2026-07-25-v1x-capabilities-design.md)
- Per-slice design + plans: [`superpowers/specs/`](../internal/specs/), [`superpowers/plans/`](../internal/plans/)
- Release narrative: [`CHANGELOG.md`](../CHANGELOG.md) §`1.1.0-beta.1`
- Related: [ADR-0002](0002-native-skills-only-plugin-removed.md) (native skills only — the foundation these slices extend), [ADR-0001](0001-doc-layout-and-spec-plan-paths.md) (doc/spec/plan layout)

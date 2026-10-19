# ADR-0014: Host hook regeneration via an explicit `noir hooks sync` command

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The scaffold emits each host's lifecycle hook (the `noir hook` dispatcher wiring) through the
adapter's `emitHooks` seam. For the two hosts whose hook config is a user-owned JSON file that
must merge with keys Noir does not own: claude's `.claude/settings.local.json` and gemini's
`.gemini/settings.json`: the manifest tags the entry `mergeJson`. `mergeJson` is deliberately
excluded from the upgrade and sync emits (`EMITTED_IN` in `scaffold.ts` sets
`mergeJson: { sync: false, upgrade: false }`) because:

1. the file is user-owned: it also carries `permissions` / `env` / `enabledPlugins` that a
   wholesale rewrite would destroy, and
2. a re-merge would resurrect a hook the user deliberately removed: the dedup marker
   (` hook`) is gone after removal, so an unconditional re-emit would re-add it.

The write-once contract that follows from this is currently expressed only in a code comment
(`scaffold.ts`), not in any decision document.

That contract leaves one genuine gap: once the hook entry is removed: by the user, or because
the project was initialized before the hook shipped and the claude/gemini migration refuses to
create a missing file (`createIfMissing: false`): **no command can restore it.** The only way
back is hand-editing the host config. `cursor` does not have this gap: its hook file is
`regenerate`-mode, so `noir sync` rewrites it on every run.

## Decision

**Add an explicit `noir hooks sync` command** as the restore path, mirroring the `noir skills
sync` surface and the `npx husky init` / `pre-commit install` idiom (an idempotent, explicit,
non-interactive command rather than magic auto-restore on `noir init --upgrade`).

- `noir hooks sync` re-emits the host's hook entry through the same `adapter.emitHooks` seam the
  scaffold uses, for the project's configured host. For `mergeJson` hosts it merges the current
  hook patch into the user-owned file, preserving every other key and any hook entry the user
  added; a missing entry is re-added, an already-present entry is a no-op.
- `--force` additionally rewrites the Noir-owned hook entries (those carrying the dedup marker)
  to the currently resolved command, so a drifted command (e.g. npm-global `noir` → the native
  shim) or a future event addition is picked up without disturbing the user's own non-Noir hooks.
- The write-once default is unchanged: `noir init --upgrade` and `noir sync` still never touch
  `mergeJson` files, so a removed hook is only restored when the user asks for it.

The command is fully non-interactive (no prompts), scriptable under `--json`, and safe on CI.

## Consequences

- The hook contract is now documented as a decision rather than only a code comment.
- One new in-process CLI command (`noir hooks sync`) plus one engine function in
  `@noir-ai/create` (`emitHooksToFile`). No daemon, no store, no new dependency.
- The `mergeJson` writer gains an optional `force` parameter; the existing scaffold call sites are
  unchanged.

## Alternatives considered

**Relocate the hook to the committed tier** (claude `.claude/settings.json` instead of
`.claude/settings.local.json`). Per Claude Code's own tier guidance, a guardrail hook is a
"protect/build" concern that belongs in a shared/committed file, not a per-machine local file;
moving it would remove the write-once gap entirely and share the hook with the team. This is a
larger, separate decision (committed vs per-machine semantics, the interaction with a team's own
`.claude/settings.json`) and is deferred to its own ADR; the command chosen here is compatible
with either tier.

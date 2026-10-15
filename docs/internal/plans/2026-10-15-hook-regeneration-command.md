# Plan — `noir hooks sync` (host hook regeneration)

ADR: `docs/decisions/0014-hook-regeneration-command.md`.

## Scope

A single new command that restores a removed claude/gemini lifecycle hook, plus the engine
function and documentation behind it. No daemon, no store, no new dependency.

## Files

- `packages/create/src/writers.ts` — `mergeJson` gains an optional `force` parameter; the force
  path removes existing dedup-marker entries before re-adding the patch entries.
- `packages/create/src/hooks.ts` — new `emitHooksToFile(root, host, { force })`: resolves the
  adapter, calls `adapter.emitHooks({ command: resolveNoirCommand() })`, and dispatches each
  emission to `regenerate` (cursor) or `mergeJson` (claude/gemini). Returns `{ host, outcomes }`.
- `packages/create/src/index.ts` — export `emitHooksToFile` + its result types.
- `packages/cli/src/commands/hooks.ts` — new `hooksSync(opts)`: `loadProjectInfo` gate, calls
  `emitHooksToFile`, reports human + `--json` results.
- `packages/cli/src/bin.ts` — register a `hooks` group with a `sync` subcommand (`--force`).
- `docs/how-to/hooks.md` — new user-facing guide (where the hook lives, the write-once contract,
  how to restore it).
- `docs/reference/cli.md` — regenerated via `pnpm docs:generate` (no hand edit).

## Tests

- `packages/create/test/writers.test.ts` — `mergeJson` force variant: replaces marker entries,
  preserves user keys and non-marker hooks.
- `packages/create/test/hooks.test.ts` — `emitHooksToFile` per host: claude/gemini merge + dedup,
  re-add when removed, `--force` refresh, cursor regenerate, no-hook host empty.
- `packages/cli/test/hooks-sync.test.ts` — uninitialized gate, missing-hook restore, idempotent
  no-op, `--json` envelope, `--force`.

## Gate

`pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate && pnpm hygiene:gate`,
then the `docs/verification-gate.md` scan. Stop before any version bump / tag / publish.

# Deprecation policy

> How Noir removes or renames a command without breaking scripts. **Zero entries today** — no `noir` command is deprecated. This document is the process that applies when one is.

## The contract

**Warn for N minor versions → redirect for N → never silently remove.**

A command or flag is never deleted in the release it is first deprecated in. It goes through three phases, each spanning at least `N = 2` minor versions (longer for heavily-used surfaces):

1. **Warn** (N minor versions) — the old form still runs and produces its normal output, but prints one redirect hint to **stderr**: `` `noir <old>` is deprecated since v<x.y.0>; use `noir <new>`. `` Nothing changes on stdout; `--json` payloads are byte-identical.
2. **Redirect** (N minor versions) — the old form still dispatches to the new implementation (so scripts keep working), and the stderr hint grows a "will be removed in `<x.y.0>`" line.
3. **Remove** — the old form is deleted only after the redirect window closes. A removed command surfaces as exit 3 (not-found) with a `did-you-mean` hint for one more minor version, then is gone.

The exit-code contract, the `--json` envelope shape, and the option spellings a script depends on are themselves stable — deprecations target *command/flag names*, not the shapes.

## Where hints appear (and how to quiet them)

Deprecation / redirect hints go to **stderr only**, via the `tip()` helper. They are silenced by:

- `--no-tips` — the CI / log-friendly switch. Add this to any pipeline that wants a quiet stderr without changing behavior.
- `--json` — a headless JSON consumer's stdout envelope must stay pristine, so `tip()` is suppressed under `--json` regardless of `--no-tips`.

Hints never appear on stdout, never change the `{ok, data}` payload, and never change the exit code.

## Registry

Deprecated forms are tracked in `packages/cli/src/bin.ts` as the `DEPRECATIONS` registry — a single source of truth scanned on every dispatch via `emitDeprecationHintsFor`. **The registry is empty today.** When an entry is added:

1. Add a `DeprecationEntry` to `DEPRECATIONS` (`oldArgv`, `newArgv`, `since`).
2. If the old form should still execute, wire a redirect in `createProgram()` so scripts keep working through the warn/redirect window.
3. Append a dated entry to [`CHANGELOG.md`](CHANGELOG.md) under the releasing version.
4. Update this file's "Current deprecations" table.

## Current deprecations

_None. No `noir` command or flag is deprecated in v1.4.x._

When that changes, the table below will list each one:

| Deprecated form | Replacement | Since | Phase | Removal target |
|---|---|---|---|---|
| _(none)_ | | | | |

## Related

- [`command-policy.md`](command-policy.md) — the interactive-vs-scriptable contract and the `--tui` / `--no-tui` / `--no-tips` global flags.
- [`roadmap.md`](roadmap.md) — forward plan and version targets.

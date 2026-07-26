# Spec — File Conflict Resolution (SP-C)

**Date:** 2026-07-26 · **Status:** core implementing (TDD); larger dedup pieces deferred to a follow-up slice · **Slice:** C (A→B→**C**)
**Discovery:** [`docs/discovery/2026-07-26-scaffold-tui-discovery.md`](../discovery/2026-07-26-scaffold-tui-discovery.md) §2.

## Problem

`regenerate`-mode files (`.mcp.json`, `AGENTS.md`) are **silently overwritten** on every `noir sync` / `noir init --force` / `noir init --upgrade` (atomic tmp+rename in `writers.ts:regenerate`). A user who hand-edited one loses their edits with no warning (discovery §1.3 G-1). There is no content-equality check and no conflict UX.

## Decisions (clarifications, 2026-07-26)

- Surface: scaffold engine (`init`/`create`/`sync`) + skill-emit (Q3).
- Conflict-menu default: **always prompt in TTY** (Q4); non-TTY/CI → preserve + warn; `--force` → overwrite.

## In scope (this slice)

### C1. Engine conflict hook (`@noir-ai/create`)

New `ScaffoldOptions`:
- `conflictPolicy?: 'overwrite' | 'preserve'` (default **`'overwrite'`** → byte-backward-compatible; existing tests unaffected).
- `onConflict?: (ctx: ConflictContext) => Promise<ConflictResolution> | ConflictResolution`, where `ConflictContext = { relPath; existing; proposed }` and `ConflictResolution = 'replace' | 'preserve' | 'rename' | 'duplicate' | 'cancel'`.

In `scaffold()`'s `regenerate` branch: when the target **exists AND differs** from the proposed bytes, resolve via `onConflict` (if provided) else `conflictPolicy` (`preserve`→preserve, `overwrite`→replace). Identical bytes are still written (no content-hash dedup — see deferred). Resolutions:
- `replace` — overwrite (current behavior).
- `preserve` — keep the user's file; report `skipped`.
- `rename` — move the user's file to `<path>.local`; write the template to `<path>`.
- `duplicate` — write the template to `<path>.noir`; keep the user's file.
- `cancel` — treat as preserve (user aborted).

The engine stays **UI-free** (no `@clack` dep) — the callback is the seam.

### C2. CLI wiring (`@noir-ai/cli`)

For `noir sync` / `noir init --force` / `noir init --upgrade`:
- **TTY + interactive** → inject an `onConflict` that renders a `@clack/prompts` `select` (Replace / Rename / Create duplicate / Preserve / Cancel) per differing file.
- **non-TTY / CI / `--no-input`** → `conflictPolicy: 'preserve'` + a stderr warning naming the file (never clobber silently in a pipe).
- **`--force`** → `conflictPolicy: 'overwrite'` (explicit re-scaffold; no prompt).

## Deferred to a follow-up slice (each is a substantial feature)

- **Content-hash dedup** — skip the write when existing === proposed (the "identical" tier). Deferred because it changes `sync`/`--upgrade` semantics (identical files move from `written` → `skipped`) and cascades through existing tests; deserves its own behavior-change pass.
- **Semantic duplicate detection** — reuse S6's local embedder (MiniLM-L6-v2 384-dim) + sqlite-vec kNN to suggest near-duplicate docs (cosine ≥ 0.90) across `.noir/`, host context files, and specs/plans. Never auto-resolved. This is the only thing that would catch the reference project's CLAUDE.md≈AGENTS.md overlap (exact-hash can't — they differ byte-wise).
- **Three-way managed-block merge** — store a "last-emitted ancestor" snapshot in `.noir/` (or recover from git) so a hand-edit *inside* a `<!-- noir:* -->` region merges instead of being strip-replaced. Needs new state (cf. Copier's `.copier-answers.yml`).
- **`noir doctor` dedup** — exact-duplicate file clusters (content-hash) + the semantic near-dups above; advisory consolidation. (The structural nested-`.noir` case is already shipped in SP-A's `checkNestedNoir`.)

## Testing (TDD, in scope)

- Engine: default `overwrite` clobbers a differing file (backward compat); `preserve` keeps it; `onConflict` drives each of replace/preserve/rename/duplicate/cancel. (`packages/create/test/scaffold-conflict.test.ts`.)
- CLI: TTY injects the `@clack` resolver; non-TTY preserves + warns; `--force` overwrites. (`packages/cli/test/`.)

## Non-goals

- The three-mode writer's `managedBlock`/`skipIfExists` paths are unchanged.
- No new runtime deps in `@noir-ai/create` (the `@clack` dep stays cli-side).

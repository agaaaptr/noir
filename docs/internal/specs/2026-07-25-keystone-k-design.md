# Keystone K — Foundation Refactor (spec)

> Slice K of the v1.x capability series. Companion: `docs/specs/2026-07-25-v1x-capabilities-design.md` (§3 unifying pattern, §5 required changes). **Pure refactor — no user-facing behavior change.** Unblocks Rules (R), Ignore (I), PRD (P), Scaffold (S), Integration (X).

## Goal

Generalize Noir's existing **canonical→host + managed-block** primitives so the five capability slices *extend* them instead of reinventing parallel mechanisms. All 729 tests stay green.

## Why first (keystone)

Every later slice reuses three things that today are narrowly scoped:
1. The **managed-block marker** primitive (`CONTEXT_BLOCK_BEGIN/END` in `@noir-ai/core/markers.ts`) + `replaceBlock()` (currently *inline* in `cli/init.ts`).
2. The **skills compiler** as a general "canonical→host artifact compiler" (today: builtin skills only).
3. **`HostAdapter`** emitters (today: `emitMcpConfig`/`emitContext`/`emitSkillsToDir`).

Generalizing these once (pure refactor) means each feature slice is an *incremental extension*, not a greenfield subsystem.

## Scope (4 changes)

### K1 — Generalize managed-block markers (`@noir-ai/core/markers.ts`)
- Add a marker-pair **factory**: `managedBlock(name, { commentStyle: 'html' | 'hash' }) → { begin, end }`.
  - `html` → `<!-- noir:<name> begin -->` … `<!-- noir:<name> end -->` (markdown/NOIR.md/CLAUDE.md).
  - `hash` → `# >>> noir:<name> >>>` … `# <<< noir:<name> <<<` (`.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`/yaml).
- Keep `CONTEXT_BLOCK_BEGIN/END` as a **backward-compatible named instance** (html style). Future named instances (`IGNORE_BLOCK`, scaffold-section markers) are added by their own slices; K only ships the **factory + `ManagedBlock` type**.
- Export from `@noir-ai/core`.

### K2 — Extract a shared managed-block writer
- Move `replaceBlock()` / `safeRead()` / `escapeRe()` out of `cli/init.ts` into a reusable module in `@noir-ai/core` (e.g. `blockWriter.ts`):
  - `writeManagedBlock(file, block: ManagedBlock, content: string): void` — read-existing → strip-region → re-append (idempotent), preserving user content outside markers.
  - `readManagedBlock(file, block): string | null`, `stripManagedBlock(content, block): string`.
- Per-file-type sentinel selection **derived from file extension** (`.md`→html, `.gitignore`/`.dockerignore`/`.npmignore`/`.yml`→hash).
- `init.ts` / `sync.ts` become **thin callers**. No behavior change to existing CLAUDE.md regeneration.

### K3 — Generalize the skills compiler (`@noir-ai/skills`)
- Refactor `compiler.ts` so the **validate → compile → emit** pipeline is parametric over an *artifact family* (today: builtin skills; future: rules, integrations). Introduce a shared compiler shape / widen types.
- Add a `discoverAll()` combinator hook (combines builtin + future integrations) but keep `discoverBuiltin` / `emitSkillsToDir` working **identically** (deprecation-free).
- `CompileTarget` stays `'claude'` (widens at S10).
- Internal refactor only — no new package, no behavior change.

### K4 — Extend `HostAdapter` (`@noir-ai/adapters`)
- Add **optional** `emitRules?(ctx: EmitContext): string` to the `HostAdapter` interface (the Rules slice consumes it; K adds the seam).
- Add an **optional** integration-aware `emitMcpConfig` overload (for the Integration slice's `gated-write-proxy`/`external-mcp` paths) — typed but unused until X.
- `claude` adapter: implement `emitRules` returning the `@.noir/rules/RULES.md` import line.
- Backward-compatible: optional methods; existing adapter behavior unchanged.

## Acceptance

- `pnpm build && pnpm lint && pnpm typecheck && pnpm test` → all green (729 tests, **0 regressions**).
- The generalized **marker factory + shared writer** exist in `@noir-ai/core` and are used by `init`/`sync` (the old inline `replaceBlock` is gone).
- `HostAdapter` has the `emitRules` seam; the claude adapter implements it.
- The skills compiler has the **generalized shape** (extension points present, behavior identical).
- **Spike proof:** a follow-up (Rules slice) can add `.noir/rules/RULES.md` + wire `emitRules` into `init`/`sync` **without touching `core`/`adapters` again**.

## Out of scope

- The actual Rules / Ignore / PRD / Scaffold / Integration **features** (subsequent slices that *use* K).
- The `@noir-ai/create` **package** (Scaffold slice S).
- Multi-host adapters beyond claude (S10).
- Config-schema additions (K adds none).

## Risks & mitigations

- **Refactor regressions** → the 729-test suite is the gate; add focused tests for the new factory/writer.
- **Over-generalizing the compiler prematurely** → parametric but *minimal*; only widen what Rules + Integration provably need (per the v1.x design doc).
- **Marker-sentinel drift** → keep `CONTEXT_BLOCK_*` bytes identical (named instance), so existing `.noir/NOIR.md`/`CLAUDE.md` files regenerate unchanged.

## Test additions

- `markers`: factory produces correct sentinels per `commentStyle`; `CONTEXT_BLOCK_*` byte-identical to today.
- `blockWriter`: write→read→strip round-trip; preserves user content outside the region; handles missing/empty file; per-extension sentinel selection; idempotent re-write.
- `emitRules` seam: claude adapter returns the import line; interface accepts the optional method.

## Implementation notes (2026-07-25)

- **K3 (skills-compiler generalization) deferred to the Integration slice** — YAGNI until a second artifact family (integrations) exists. K shipped: markers factory (K1), shared blockWriter (K2), emitRules seam (K4). Verified: 741 tests green, typecheck green, lint green.
- Pre-existing biome lint errors in v1.0-beta files (`commands/context.ts`, `test/commands.test.ts`, `commands/daemon.ts`, `commands/status.ts`, `daemon-client.ts`) were auto-fixed in a separate `chore(lint)` commit — **not introduced by K**; K's files are lint-clean.

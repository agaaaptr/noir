# Keystone K — Foundation Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize Noir's managed-block + host-emit primitives into reusable foundations so the Rules/Ignore/Scaffold/Integration slices extend them — pure refactor, zero behavior change.

**Architecture:** (1) a `managedBlock(name, commentStyle)` factory in `@noir-ai/core` (keeps `CONTEXT_BLOCK_*` byte-identical); (2) a shared `blockWriter` module extracted from `cli/init.ts`'s inline `replaceBlock`; (3) an `emitRules?` seam on `HostAdapter` + claude impl. The skills-compiler generalization (original K3) is **deferred to the Integration slice** — YAGNI until a second artifact family exists.

**Tech Stack:** TypeScript ESM, pnpm workspace, tsup, vitest, Biome, zod v4.

## Global Constraints

- **No behavior change** — every existing test stays green; `CONTEXT_BLOCK_BEGIN`/`END` remain the exact bytes `<!-- noir:context begin -->` / `<!-- noir:context end -->`.
- Test gate: `pnpm build && pnpm lint && pnpm typecheck && pnpm test` all green (currently 729 tests).
- Tests live at `packages/<pkg>/test/<name>.test.ts` (vitest), importing from the package source (relative `../src/...js`) or the workspace package.
- Commits are **local on `develop`** — do NOT push. One commit per task.
- ESM + `node:fs`/`node:path`; no new runtime deps.

## File Structure

- `packages/core/src/markers.ts` — add `managedBlock` factory + `ManagedBlock`/`CommentStyle` types + `CONTEXT_BLOCK`/`RULES_BLOCK` named instances; keep `CONTEXT_BLOCK_BEGIN/END`.
- `packages/core/src/block-writer.ts` — NEW: `writeManagedRegion` / `readManagedBlock` / `stripManagedBlock` / `commentStyleFor` (extracted from `cli/init.ts`).
- `packages/core/src/index.ts` — export the new symbols.
- `packages/core/test/markers.test.ts` — NEW.
- `packages/core/test/block-writer.test.ts` — NEW.
- `packages/cli/src/init.ts` — replace inline `replaceBlock`/`safeRead`/`escapeRe` with `writeManagedRegion`.
- `packages/adapters/src/types.ts` — add optional `emitRules?(ctx): string` to `HostAdapter`.
- `packages/adapters/src/claude.ts` — implement `emitRules`.
- `packages/adapters/test/claude.test.ts` — add `emitRules` test.

---

### Task 1: `managedBlock` factory + named instances (`@noir-ai/core/markers.ts`)

**Files:**
- Modify: `packages/core/src/markers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/markers.test.ts`

**Interfaces:**
- Produces: `managedBlock(name: string, commentStyle?: CommentStyle): ManagedBlock`; `ManagedBlock { name; commentStyle; begin; end }`; `CommentStyle = 'html' | 'hash'`; named instances `CONTEXT_BLOCK`, `RULES_BLOCK`; (kept) `CONTEXT_BLOCK_BEGIN`, `CONTEXT_BLOCK_END`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/markers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  managedBlock,
  CONTEXT_BLOCK,
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  RULES_BLOCK,
} from '@noir-ai/core';

describe('managedBlock factory', () => {
  it('produces html sentinels', () => {
    const b = managedBlock('context', 'html');
    expect(b.begin).toBe('<!-- noir:context begin -->');
    expect(b.end).toBe('<!-- noir:context end -->');
    expect(b.commentStyle).toBe('html');
  });

  it('produces hash sentinels for ignore-style files', () => {
    const b = managedBlock('ignore', 'hash');
    expect(b.begin).toBe('# >>> noir:ignore >>>');
    expect(b.end).toBe('# <<< noir:ignore <<<');
  });

  it('defaults to html', () => {
    expect(managedBlock('x').commentStyle).toBe('html');
  });

  it('keeps CONTEXT_BLOCK_* byte-identical (backward compat)', () => {
    expect(CONTEXT_BLOCK_BEGIN).toBe('<!-- noir:context begin -->');
    expect(CONTEXT_BLOCK_END).toBe('<!-- noir:context end -->');
    expect(CONTEXT_BLOCK.begin).toBe(CONTEXT_BLOCK_BEGIN);
    expect(CONTEXT_BLOCK.end).toBe(CONTEXT_BLOCK_END);
  });

  it('ships a RULES_BLOCK named instance', () => {
    expect(RULES_BLOCK.begin).toBe('<!-- noir:rules begin -->');
    expect(RULES_BLOCK.end).toBe('<!-- noir:rules end -->');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @noir-ai/core test -- markers`
Expected: FAIL — `managedBlock`/`CONTEXT_BLOCK`/`RULES_BLOCK` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/markers.ts` (full replacement):
```ts
export type CommentStyle = 'html' | 'hash';

export interface ManagedBlock {
  readonly name: string;
  readonly commentStyle: CommentStyle;
  readonly begin: string;
  readonly end: string;
}

/** Build a matched begin/end marker pair for a managed region.
 *  `html` → `<!-- noir:<name> begin -->` (markdown / CLAUDE.md / NOIR.md).
 *  `hash` → `# >>> noir:<name> >>>` (.gitignore / .dockerignore / .npmignore / yml). */
export function managedBlock(name: string, commentStyle: CommentStyle = 'html'): ManagedBlock {
  if (commentStyle === 'hash') {
    return { name, commentStyle, begin: `# >>> noir:${name} >>>`, end: `# <<< noir:${name} <<<` };
  }
  return { name, commentStyle, begin: `<!-- noir:${name} begin -->`, end: `<!-- noir:${name} end -->` };
}

/** Named instances. CONTEXT_BLOCK_* are kept byte-identical for backward compat. */
export const CONTEXT_BLOCK = managedBlock('context', 'html');
export const RULES_BLOCK = managedBlock('rules', 'html');
export const CONTEXT_BLOCK_BEGIN = CONTEXT_BLOCK.begin;
export const CONTEXT_BLOCK_END = CONTEXT_BLOCK.end;
```

`packages/core/src/index.ts` — add to the existing markers re-export line:
```ts
export {
  type CommentStyle,
  type ManagedBlock,
  managedBlock,
  CONTEXT_BLOCK,
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  RULES_BLOCK,
} from './markers.js';
```
(Remove the old single-line `export { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from './markers.js';`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @noir-ai/core test -- markers`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/markers.ts packages/core/src/index.ts packages/core/test/markers.test.ts
git commit -m "feat(core): managedBlock factory + CONTEXT/RULES named instances (keystone K1)"
```

---

### Task 2: Shared `blockWriter` + refactor `init.ts` (`@noir-ai/core`)

**Files:**
- Create: `packages/core/src/block-writer.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/init.ts`
- Test: `packages/core/test/block-writer.test.ts`

**Interfaces:**
- Consumes: `ManagedBlock` from Task 1.
- Produces: `writeManagedRegion(file, block, regionText): void`; `readManagedBlock(file, block): string | null`; `stripManagedBlock(content, block): string`; `commentStyleFor(file): CommentStyle`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/block-writer.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_BLOCK,
  writeManagedRegion,
  readManagedBlock,
  stripManagedBlock,
  commentStyleFor,
} from '@noir-ai/core';

const region = (body: string) => `${CONTEXT_BLOCK.begin}\n${body}\n${CONTEXT_BLOCK.end}\n`;

describe('blockWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bw-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a fresh region into a missing file', () => {
    const f = join(dir, 'CLAUDE.md');
    writeManagedRegion(f, CONTEXT_BLOCK, region('@import ".noir/NOIR.md"'));
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('@import ".noir/NOIR.md"');
    expect(out.trimEnd()).endsWith(CONTEXT_BLOCK.end);
  });

  it('is idempotent: re-write replaces the old region, preserves user content', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, 'user header\n\n', 'utf8');
    writeManagedRegion(f, CONTEXT_BLOCK, region('OLD'));
    writeManagedRegion(f, CONTEXT_BLOCK, region('NEW'));
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('user header');
    expect(out).not.toContain('OLD');
    expect(out).toContain('NEW');
    expect((out.match(/<!-- noir:context begin -->/g) ?? []).length).toBe(1);
  });

  it('stripManagedBlock removes only the region', () => {
    const content = `keep\n${CONTEXT_BLOCK.begin}\nx\n${CONTEXT_BLOCK.end}\nalso keep\n`;
    expect(stripManagedBlock(content, CONTEXT_BLOCK)).toBe(`keep\nalso keep\n`);
  });

  it('readManagedBlock returns null when file missing', () => {
    expect(readManagedBlock(join(dir, 'nope.md'), CONTEXT_BLOCK)).toBeNull();
  });

  it('readManagedBlock returns the region when present', () => {
    const f = join(dir, 'CLAUDE.md');
    writeManagedRegion(f, CONTEXT_BLOCK, region('BODY'));
    expect(readManagedBlock(f, CONTEXT_BLOCK)).toContain('BODY');
  });

  it('commentStyleFor: html for .md, hash for ignore/yml', () => {
    expect(commentStyleFor('CLAUDE.md')).toBe('html');
    expect(commentStyleFor('.gitignore')).toBe('hash');
    expect(commentStyleFor('.dockerignore')).toBe('hash');
    expect(commentStyleFor('config.yml')).toBe('hash');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @noir-ai/core test -- block-writer`
Expected: FAIL — `writeManagedRegion` etc. not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/block-writer.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { CommentStyle, ManagedBlock } from './markers.js';

const HASH_FILES = new Set([
  '.gitignore',
  '.dockerignore',
  '.npmignore',
  '.prettierignore',
  '.eslintignore',
  '.ignore',
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pick a comment style for a managed region from a file path. */
export function commentStyleFor(file: string): CommentStyle {
  const lower = file.toLowerCase();
  if (HASH_FILES.has(basename(lower))) return 'hash';
  const ext = extname(lower);
  if (ext === '.yml' || ext === '.yaml') return 'hash';
  return 'html';
}

/** Remove every `<begin>…<end>` region for `block` from `content`. */
export function stripManagedBlock(content: string, block: ManagedBlock): string {
  const re = new RegExp(`${escapeRe(block.begin)}[\\s\\S]*?${escapeRe(block.end)}\\n?`, 'g');
  return content.replace(re, '');
}

/** Read the first `<begin>…<end>` region for `block` from `file`, or null if absent/missing. */
export function readManagedBlock(file: string, block: ManagedBlock): string | null {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = content.match(new RegExp(`${escapeRe(block.begin)}[\\s\\S]*?${escapeRe(block.end)}`));
  return m && m[0] ? m[0] : null;
}

/** Idempotently write `regionText` (a full `<begin>…<end>` block) into `file`,
 *  stripping any prior region for `block` and preserving all other content. */
export function writeManagedRegion(file: string, block: ManagedBlock, regionText: string): void {
  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    /* missing → treat as empty */
  }
  const stripped = stripManagedBlock(content, block);
  const next = `${stripped ? `${stripped.trimEnd()}\n\n` : ''}${regionText}`;
  writeFileSync(file, next, 'utf8');
}
```

Add to `packages/core/src/index.ts`:
```ts
export {
  commentStyleFor,
  readManagedBlock,
  stripManagedBlock,
  writeManagedRegion,
} from './block-writer.js';
```

Refactor `packages/cli/src/init.ts`:
- Change the import from `@noir-ai/core` to: `import { CONTEXT_BLOCK, createProjectId, paths, writeManagedRegion } from '@noir-ai/core';` (drop `CONTEXT_BLOCK_BEGIN`/`CONTEXT_BLOCK_END` — no longer used here).
- Replace the block:
  ```ts
  const existing = safeRead(join(root, 'CLAUDE.md'));
  writeFileSync(
    join(root, 'CLAUDE.md'),
    replaceBlock(existing, claudeAdapter.emitContext({ root })),
    'utf8',
  );
  ```
  with:
  ```ts
  writeManagedRegion(join(root, 'CLAUDE.md'), CONTEXT_BLOCK, claudeAdapter.emitContext({ root }));
  ```
- Delete the now-unused local helpers `safeRead`, `replaceBlock`, `escapeRe`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @noir-ai/core test -- block-writer`
Run: `pnpm --filter @noir-ai/cli test -- init`
Expected: both PASS; `init` tests unchanged (behavior identical — `emitContext` still returns the same wrapped block).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/block-writer.ts packages/core/src/index.ts packages/core/test/block-writer.test.ts packages/cli/src/init.ts
git commit -m "refactor(core,cli): extract shared blockWriter; init.ts uses writeManagedRegion (keystone K2)"
```

---

### Task 3: `emitRules` seam on `HostAdapter` + claude impl (`@noir-ai/adapters`)

**Files:**
- Modify: `packages/adapters/src/types.ts`
- Modify: `packages/adapters/src/claude.ts`
- Test: `packages/adapters/test/claude.test.ts`

**Interfaces:**
- Consumes: `RULES_BLOCK` from Task 1.
- Produces: `HostAdapter.emitRules?(ctx: EmitContext): string`; claude returns the `@.noir/rules/RULES.md` managed import block.

- [ ] **Step 1: Write the failing test**

Append to `packages/adapters/test/claude.test.ts` (import `claudeAdapter` the same way the existing tests in that file do):
```ts
import { describe, it, expect } from 'vitest';
import { claudeAdapter } from '../src/claude.js';

describe('claudeAdapter.emitRules', () => {
  it('returns a rules @import managed block', () => {
    const out = (claudeAdapter.emitRules as (c: { root: string }) => string)({ root: '/x' });
    expect(out).toContain('<!-- noir:rules begin -->');
    expect(out).toContain('@import ".noir/rules/RULES.md"');
    expect(out).toContain('<!-- noir:rules end -->');
  });
});
```
(If the file already has a top-level `describe`/imports, merge this `describe` block in rather than duplicating imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @noir-ai/adapters test -- claude`
Expected: FAIL — `emitRules` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

`packages/adapters/src/types.ts` — add to the `HostAdapter` interface (after `emitContext`):
```ts
  /** Managed block inserting the host's AI-rules import (e.g. @.noir/rules/RULES.md). */
  emitRules?(ctx: EmitContext): string;
```

`packages/adapters/src/claude.ts` — update the import and add the method:
```ts
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
```
(add `RULES_BLOCK` to the existing import), and inside `claudeAdapter` add after `emitContext`:
```ts
  emitRules(_ctx: EmitContext): string {
    return `${RULES_BLOCK.begin}\n@import ".noir/rules/RULES.md"\n${RULES_BLOCK.end}\n`;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @noir-ai/adapters test -- claude`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/src/types.ts packages/adapters/src/claude.ts packages/adapters/test/claude.test.ts
git commit -m "feat(adapters): HostAdapter.emitRules seam + claude impl (keystone K4)"
```

---

### Task 4: Integration verify + K3-deferral note

**Files:** none (verification + doc note).

- [ ] **Step 1: Full build/lint/typecheck/test gate**

Run: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green; test count = 729 + 5 (markers) + 6 (block-writer) + 1 (emitRules) = **741** (adjust if existing test files absorbed the new cases).

- [ ] **Step 2: Spike-check the keystone claim**

Confirm (read-only) that a hypothetical Rules slice could now: (a) call `writeManagedRegion(CLAUDE.md, RULES_BLOCK, adapter.emitRules(ctx))` without touching `core`/`adapters`; (b) use `commentStyleFor('.gitignore')` for the Ignore slice. No code written — just confirm the seams exist and are exported from `@noir-ai/core`.

- [ ] **Step 3: Note the K3 deferral**

Append to `docs/superpowers/specs/2026-07-25-keystone-k-design.md` (under a new "## Implementation notes" section): "K3 (skills-compiler generalization) deferred to the Integration slice — YAGNI until a second artifact family (integrations) exists. K shipped: markers factory (K1), shared blockWriter (K2), emitRules seam (K4)."

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-25-keystone-k-design.md
git commit -m "docs(keystone-k): note K3 deferral to Integration slice"
```

---

## Self-Review

- **Spec coverage:** K1 (markers factory) → Task 1; K2 (blockWriter + init refactor) → Task 2; K4 (emitRules seam) → Task 3; acceptance gate → Task 4. K3 deferred (noted). ✓
- **Placeholders:** none — each step has real test code + real impl code + exact run commands.
- **Type consistency:** `ManagedBlock`/`CommentStyle` (Task 1) consumed by `blockWriter` (Task 2) and `RULES_BLOCK` (Task 1) consumed by `emitRules` (Task 3). Names match across tasks. ✓
- **Behavior preservation:** `CONTEXT_BLOCK_BEGIN/END` bytes unchanged (Task 1 test asserts it); `emitContext` untouched; `init.ts` swap is behavior-equivalent (Task 2 keeps the `init` tests as the regression gate). ✓

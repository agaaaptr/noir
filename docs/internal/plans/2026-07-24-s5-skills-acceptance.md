# S5 Skills — Manual Acceptance Checklist

> **Living document.** This checklist validates that the Noir builtin skill pack emits end-to-end: `noir init` / `noir sync` write all 28 `noir-*` skills to `.claude/skills/`, the compiler validates them, every `description` reads as a WHEN trigger, a WHAT-description is rejected, and no predecessor/Superpowers rhetoric survives in any shipped skill. Follow each step; check the box when satisfied.

**Reference:** S5 spec (`docs/internal/specs/2026-07-24-s5-skills-design.md`), implementation plan (`docs/internal/plans/2026-07-24-s5-skills.md`), and source (`packages/skills/`, `packages/adapters/src/claude.ts`, `packages/cli/src/init.ts`, `packages/cli/src/sync.ts`).

---

## Prerequisites

- [ ] Noir toolkit built: `pnpm -r build` (all 7 packages compile; `@noir-ai/skills` ships `dist/` + `builtin/`).
- [ ] Tests green: `pnpm test` (142/142 tests pass — 21 in `packages/skills/` + the `skills-emit` integration test in `packages/cli/`).
- [ ] CLI runs: `node packages/cli/dist/bin.js --help` (no stack trace).

---

## 1. `noir init` writes the full pack

**Goal:** A fresh `noir init` in a scratch project produces exactly 28 `noir-*` skill directories under `.claude/skills/`, each with a `SKILL.md`.

### 1.1 Scaffold into a scratch dir

```bash
SCRATCH=$(mktemp -d /tmp/noir-s5-XXXX)
cd "$SCRATCH"
node /path/to/noir/packages/cli/dist/bin.js init
```

**Expected stderr line (emit reports on stderr, not stdout):** `Emitted 28 Noir skills to .claude/skills/.`

### 1.2 Verify the pack on disk

```bash
ls "$SCRATCH/.claude/skills/" | grep -c '^noir-'    # → 28
ls "$SCRATCH/.claude/skills/" | sort                # 28 noir-* dirs, no non-noir entries
# every skill dir has a SKILL.md
for d in "$SCRATCH/.claude/skills/noir-"*; do
  test -f "$d/SKILL.md" || echo "MISSING: $d"
done
```

**Check:**
- [ ] `grep -c '^noir-'` returns exactly **28**.
- [ ] No non-`noir-` directories exist under `.claude/skills/` (no leftover plugin/skill residue).
- [ ] Every `noir-*` directory contains a `SKILL.md`.
- [ ] No `.claude/skills/noir-*/` entry is a stale/empty dir.

### 1.3 Category breakdown (16 full + 12 stubs)

```bash
# Stubs carry the "> **Stub:**" marker in the body
grep -l '^\s*>\s*\*\*Stub' "$SCRATCH/.claude/skills/noir-"*/SKILL.md | wc -l   # → 12
# Full playbooks = 28 − 12 = 16
```

**Expected 12 stubs:** `noir-backend noir-branch noir-commit noir-doctor noir-frontend noir-pr noir-readme noir-security noir-skill-author noir-test noir-worktree noir-wrap`.

**Check:**
- [ ] Exactly **12** SKILL.md files contain the `> **Stub:**` marker.
- [ ] The remaining **16** are full playbooks (no stub marker).

---

## 2. `noir sync` is idempotent

**Goal:** Re-running emit produces the same 28 skills, byte-for-byte; nothing is duplicated, nothing drifts.

```bash
cd "$SCRATCH"
# snapshot after init
find .claude/skills -type f | sort > /tmp/s5-snapshot-1.txt
sha1sum .claude/skills/noir-*/SKILL.md | sort > /tmp/s5-sha-1.txt

# re-emit
node /path/to/noir/packages/cli/dist/bin.js sync
# Expected stderr: "Synced 28 Noir skills to .claude/skills/."

find .claude/skills -type f | sort > /tmp/s5-snapshot-2.txt
sha1sum .claude/skills/noir-*/SKILL.md | sort > /tmp/s5-sha-2.txt

diff /tmp/s5-snapshot-1.txt /tmp/s5-snapshot-2.txt   # → no diff
diff /tmp/s5-sha-1.txt       /tmp/s5-sha-2.txt        # → no diff
```

**Check:**
- [ ] `sync` reports `Synced 28 Noir skills to .claude/skills/.` on stderr.
- [ ] File list before == file list after (no new files, no deletions).
- [ ] SHA-1 of each `SKILL.md` before == after (content is deterministic).
- [ ] Skill count remains exactly 28 (no duplication like `noir-sync-1/`).

---

## 3. Every `description` reads as a WHEN trigger

**Goal:** Confirm the compiler's `description = WHEN` rule held for all 28 shipped skills. A valid description must **lead with** a WHEN cue (`use`/`using`/`used`/`whenever`/`when`/`before`/`after`/`while`/`starting`/`encountering`/`completing`/`creating`/`about to`/`upon`/`during`/`to`/`for`/`on`/…) — it states **when to fire**, not **what the skill does**. The compiler enforces a **leading cue** (a guardrail against the common WHAT pattern, not a full NLP check).

```bash
# Extract every description from the emitted pack
for f in "$SCRATCH/.claude/skills/noir-"*/SKILL.md; do
  awk '/^---$/{c++} c==1 && /^description:/{print; exit}' "$f"
done | sort
```

**Sample (expected shape — each begins with a WHEN verb):**

```
description: Use at the start of a session — to load project context …
description: Use before any creative work — creating features …
description: Use when creating a git commit — to scope changes …
description: Use when turning a brainstormed idea into a formal spec …
```

**Check:**
- [ ] All 28 `description:` lines start with a WHEN verb (`Use`/`Using`/`Whenever`/`When`/`Before`/`After`/`While`/…).
- [ ] No description reads as a pure WHAT (e.g., "A skill that writes commits" or "Git commit helper") — those would have been rejected at emit time.
- [ ] No description is empty or over 1024 chars (`MAX_DESC`).

---

## 4. A WHAT-description is rejected

**Goal:** Demonstrate the compiler's fail-fast validation. Feeding it a skill whose `description` is a WHAT (not a WHEN) must throw, and emit must abort before writing anything.

### 4.1 Build a bad fixture

```bash
FIX=$(mktemp -d /tmp/noir-s5-bad-XXXX)
mkdir -p "$FIX/builtin/noir-bad"
cat > "$FIX/builtin/noir-bad/SKILL.md" <<'EOF'
---
name: noir-bad
description: A commit helper skill.    # ← WHAT, not WHEN; no "use/when/before/…"
---

# Noir Bad

Body does not matter; the frontmatter fails validation.
EOF
```

### 4.2 Run the compiler directly and watch it reject

```typescript
// packages/skills/test/compiler.test.ts already covers this; to demonstrate live:
import { discoverBuiltin, validateSkill } from '@noir-ai/skills';

const [bad] = discoverBuiltin(`${FIX}/builtin`);
const res = validateSkill(bad);
console.log(res);
// → { ok: false, errors: ['description must state WHEN to trigger (e.g. "Use when…"), not WHAT it does'] }
```

### 4.3 Emit aborts before writing

```typescript
import { emitSkillsToDir } from '@noir-ai/skills';

await emitSkillsToDir(`${FIX}/.claude/skills`, { builtinDir: `${FIX}/builtin` });
// → throws: "Invalid builtin skill noir-bad: description must state WHEN to trigger …"
```

```bash
# Confirm nothing was written (emit is fail-fast / atomic-ish)
test -d "$FIX/.claude/skills" && echo "LEAK" || echo "clean"
# → clean
```

**Check:**
- [ ] `validateSkill` returns `{ ok: false, errors: ['description must state WHEN …'] }`.
- [ ] `emitSkillsToDir` throws on the invalid skill.
- [ ] No `noir-bad/` directory is created on disk — emit validates the **whole pack** before writing.

### 4.4 Negative cases the compiler also rejects (spot-check via the hygiene test)

```bash
pnpm --filter @noir-ai/skills test
```

The `compiler.test.ts` suite asserts rejection of: missing `name`, name not matching `noir-<kebab>`, dir ≠ name, missing `description`, description > 1024 chars, and a WHAT-description.

**Check:**
- [ ] `packages/skills/test/compiler.test.ts` (15 tests) passes — these are the negative cases above.
- [ ] `packages/skills/test/builtin-hygiene.test.ts` (6 tests) passes — every shipped skill passes validation **and** the `FORBIDDEN_RESIDUE` check.

---

## 5. No predecessor / Superpowers residue

**Goal:** Confirm ported content was stripped of rhetoric, not transplanted. The hygiene test's `FORBIDDEN_RESIDUE` list rejects tokens from both sources.

```bash
# Tokens that must NOT appear anywhere in the emitted pack
RESIDUE='<EXTREMELY-IMPORTANT|SUBAGENT-STOP|HARD GATE|Spine|EXTREMELY IMPORTANT|rationaliz'
grep -rEi "$RESIDUE" "$SCRATCH/.claude/skills/noir-"*/SKILL.md "$SCRATCH/.claude/skills/noir-"*/references/*.md 2>/dev/null
# → no matches
```

**Full `FORBIDDEN_RESIDUE` list** (from `packages/skills/src/residue.ts`): includes `<EXTREMELY-IMPORTANT`, `SUBAGENT-STOP`, predecessor-plugin internal section headers, and "HARD GATE"/"Spine" framing. The hygiene test enforces all of them.

**Check:**
- [ ] Zero `grep` matches for any forbidden residue token across the 28 skills + their `references/*.md`.
- [ ] Discipline language, where present, points to the **S4 engine's observable gates** (not to in-skill shouty rhetoric).

### 5.1 Stubs carry the stub marker

```bash
# Every stub must have the marker (real skills, not placeholder files)
for s in noir-backend noir-branch noir-commit noir-doctor noir-frontend \
         noir-pr noir-readme noir-security noir-skill-author noir-test \
         noir-worktree noir-wrap; do
  grep -q '^\s*>\s*\*\*Stub' "$SCRATCH/.claude/skills/$s/SKILL.md" \
    || echo "MISSING STUB MARKER: $s"
done
# → no output
```

**Check:**
- [ ] All 12 stubs have the `> **Stub:**` marker and a "For now" pointer.
- [ ] Stubs still pass `validateSkill` (valid WHEN `description` + non-empty body).

---

## 6. Full pipeline validation

**Goal:** Confirm the entire S5 implementation passes lint, typecheck, build, and test.

```bash
cd /path/to/noir
pnpm lint        # Biome — clean (2 deprecation infos about schema version; not failures)
pnpm typecheck   # tsc --noEmit across 7 packages — clean
pnpm -r build    # all 7 packages emit dist/ — clean
pnpm test        # Vitest — 142/142 tests green
```

**Check:**
- [ ] `pnpm lint` exits 0 (no Biome errors).
- [ ] `pnpm typecheck` exits 0 (no TS errors).
- [ ] `pnpm -r build` succeeds (all 7 packages emit `dist/`; `@noir-ai/skills` also ships `builtin/`).
- [ ] `pnpm test` reports **142/142** tests pass (29 test files; including `packages/skills/` 21 + `packages/cli/test/skills-emit.test.ts` 3).
- [ ] The CLI integration tests print `Emitted 28 Noir skills to .claude/skills/.` and `Synced 28 Noir skills to .claude/skills/.` — live end-to-end evidence of emit.

---

## Final acceptance

- [ ] `noir init` writes exactly **28** `noir-*` skills to `.claude/skills/` (16 full + 12 stubs).
- [ ] `noir sync` re-emits idempotently (same content, same SHA, no drift, no duplicates).
- [ ] Every shipped `description` reads as a WHEN trigger (starts with `use`/`when`/`before`/…).
- [ ] A WHAT-description is rejected by `validateSkill`, and `emitSkillsToDir` aborts before writing.
- [ ] No predecessor/Superpowers residue (`FORBIDDEN_RESIDUE`) in any shipped skill or reference.
- [ ] Full pipeline green: lint + typecheck + build + **142/142 tests**.
- [ ] No scope creep (S5 scope: pack + copy+validate compiler + emit on init/sync; no LLM drafting — that's S8).

**S5 is accepted when all checkboxes are satisfied.**

---

## Notes for the reviewer

- **`@noir-ai/skills` is content + a small compiler.** It depends on `core` only. The compiler is pure I/O over the shipped `builtin/` directory; it never imports the predecessor plugin or Superpowers at runtime (DS-7).
- **`builtin/` is shipped, not bundled.** `discoverBuiltin()` resolves it from `import.meta.url` (parent of the module dir = package root in both `src` and `dist`). `package.json` `files` includes `"builtin"`. Do not relocate `discover.ts` without re-deriving the depth.
- **Stubs are real skills.** A stub has a valid WHEN `description`, a body with the `> **Stub:**` marker, and a one-line "For now" pointer. It must pass validation and load in the host.
- **stdout discipline:** emit/init/sync report on **stderr** (matching the existing CLI convention). No stdout in the compiler/emit path.
- **Build-before-integration-test:** the CLI integration test consumes `@noir-ai/skills`' built `dist` + shipped `builtin/`, so run `pnpm -r build` before `pnpm --filter @noir-ai/cli test`. The skills package's own unit tests import `../src` and need no build.

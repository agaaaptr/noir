# C3 Skills Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen all 33 builtin skills + 1 integration to canonical-quality playbooks; add runtime-derived skill registry, structural quality gate, and offline evals harness; sync all docs so C3 → Completed, with zero tech debt.

**Architecture:** Infra-first (compiler quality gate + registry + evals runner + CLI) lands and is green before content rewrite; content is rewritten in 6 cluster tasks (each a self-contained, testable batch of skills); docs sync + full gate closes the session. Frontmatter `metadata.{category,version}` + `license` + `compatibility` + WHAT+WHEN description are the single source of truth; registry and docs are derived from them.

**Tech Stack:** Node ≥22, pnpm workspace, TypeScript ESM (strict, noUncheckedIndexedAccess), vitest, `yaml` (frontmatter parse), `zod` (integration schema).

**Spec:** `docs/internal/specs/2026-08-10-c3-skills-enhancement-design.md`

## Global Constraints

- **Node ≥22, pnpm, ESM.** TypeScript `strict` + `noUncheckedIndexedAccess`, declaration.
- **Full gate every task:** `pnpm lint → build → typecheck → test → docs:validate` must be green before claiming done. Commits stay local on `develop`; push only on explicit user request.
- **Test suite runs offline/free** — never a network call or paid key. Evals are offline assertions only (no LLM).
- **`FORBIDDEN_RESIDUE`** (`packages/skills/src/residue.ts`) — never introduce Superpowers rhetoric (`<EXTREMELY-IMPORTANT`, `SUBAGENT-STOP`, all-caps Iron Laws, `| Excuse | Reality |` tables). Adopt ideas, re-implement as original native Noir.
- **Frontmatter source of truth:** `{name, description, metadata{category,version}, license, compatibility}`. Description MUST be single-line WHAT+WHEN (docs-generate reads `description:\s*(.+)` — multi-line breaks it).
- **Category taxonomy** (fixed): `discovery` `spec` `plan` `execute` `verify` `document` `git` `memory` `context` `domain` `meta` `integration`.
- **No committed registry file** — registry is runtime-derived from `discoverAll()`.
- **Conventional Commits**, scope per package (`feat(skills):`, `docs:`, `test(skills):`).
- **Backlog `references/` code-path coverage** must close (≥5 shipped skills use `references/`).

---

### Task 1: Extend `SkillFrontmatter` + frontmatter parse to tolerate metadata/license/compatibility

**Files:**
- Modify: `packages/skills/src/types.ts` (SkillFrontmatter)
- Test: `packages/skills/test/compiler.test.ts`

**Interfaces:**
- Produces: `SkillFrontmatter` gains optional `metadata?: {category?: string; version?: string}`, `license?: string`, `compatibility?: string`. `parseFrontmatter()` unchanged behavior (index signature already tolerates extra keys).

- [ ] **Step 1: Write the failing test** — add to `compiler.test.ts`:

```ts
it('tolerates metadata/license/compatibility in frontmatter', () => {
  const fm = parseFrontmatter(`---
name: noir-x
description: Drafts specs. Use when turning an idea into a spec.
metadata:
  category: spec
  version: 1.0.0
license: MIT
compatibility: claude
---
# noir-x`);
  expect(fm.metadata?.category).toBe('spec');
  expect(fm.metadata?.version).toBe('1.0.0');
  expect(fm.license).toBe('MIT');
});
```

- [ ] **Step 2: Run test** — `pnpm vitest run packages/skills/test/compiler.test.ts`
  Expected: FAIL (metadata typed as `[k:string]:unknown`, no `metadata` accessor).

- [ ] **Step 3: Extend the type** — in `types.ts`:

```ts
export interface SkillFrontmatter {
  name: string;
  description: string;
  references?: string[];
  metadata?: { category?: string; version?: string };
  license?: string;
  compatibility?: string;
  [k: string]: unknown; // tolerate + ignore extra keys
}
```

- [ ] **Step 4: Run test** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add packages/skills/src/types.ts packages/skills/test/compiler.test.ts && git commit -m "feat(skills): frontmatter tolerates metadata/license/compatibility"`

---

### Task 2: Structural quality gate in `validateSkill` (metadata, sections, line budget, one-level refs, WHAT clause)

**Files:**
- Modify: `packages/skills/src/compiler.ts` (`validateSkill`), `packages/skills/src/types.ts` (ValidationResult — add `warnings?`)
- Create: `packages/skills/src/quality.ts` (section/budget/depth checks)
- Modify: `packages/skills/test/compiler.test.ts`, `packages/skills/test/builtin-hygiene.test.ts`

**Interfaces:**
- Consumes: `SkillFrontmatter` (Task 1).
- Produces:
  - `quality.ts`: `export const REQUIRED_SECTIONS: string[]`; `export function checkRequiredSections(body: string): string[]`; `export function checkLineBudget(body: string, max = 500): boolean`; `export function checkOneLevelRefs(skill: BuiltinSkill): string[]`; `export function hasWhatClause(description: string): boolean`.
  - `validateSkill(skill)` now returns `{ok, errors, warnings?}` — new ERRORS: missing metadata (no `category`/`version`), missing required section(s), body >500 lines, chained references, no WHAT clause. New WARNINGS: body <20 lines, no code fence/example, first/second-person narration, voodoo constants.
  - `ValidationResult` gains `warnings?: string[]`.

- [ ] **Step 1: Write failing tests** — in `compiler.test.ts` add `describe('validateSkill: structural gate')`:

```ts
const okSkill = `---
name: noir-x
description: Drafts specs. Use when turning an idea into a spec.
metadata:
  category: spec
  version: 1.0.0
license: MIT
compatibility: claude
---
# noir-x
Overview sentence.
## When to use
- when an idea needs formalizing
## Procedure
1. **Write it** — down.
## Verification
- [ ] spec written
## Notes
- routes to noir-plan`;
it('passes a skill with metadata + all sections + WHAT clause', async () => {
  await writeSkill('noir-x', okSkill);
  expect(validateSkill(firstSkill(fixture)).ok).toBe(true);
});
it('rejects a skill missing metadata', async () => {
  await writeSkill('noir-x', `---\nname: noir-x\ndescription: Drafts. Use when drafting.\n---\n# noir-x\n## Procedure\n1. x`);
  expect(validateSkill(firstSkill(fixture)).errors.join('; ')).toMatch(/metadata/i);
});
it('rejects a skill missing required sections', async () => {
  await writeSkill('noir-x', `---\nname: noir-x\ndescription: Drafts. Use when drafting.\nmetadata:\n  category: spec\n  version: 1.0.0\nlicense: MIT\n---\n# noir-x\n## Procedure\n1. x`);
  expect(validateSkill(firstSkill(fixture)).errors.join('; ')).toMatch(/section/i);
});
it('rejects a WHAT-only description (no WHEN lead)', async () => {
  await writeSkill('noir-x', `---\nname: noir-x\ndescription: Drafts specs for the team.\nmetadata:\n  category: spec\n  version: 1.0.0\nlicense: MIT\n---\n# noir-x\n## When to use\n- x\n## Procedure\n1. x\n## Notes\n- x`);
  expect(validateSkill(firstSkill(fixture)).ok).toBe(false);
});
```

- [ ] **Step 2: Run tests** — Expected: FAIL (new rules not implemented).
- [ ] **Step 3: Implement** — in `quality.ts` + wire into `validateSkill`. `checkRequiredSections` requires `## When to use` OR `## When to Use`, `## Procedure` OR `## Steps`, and one of `## Verification` / `## Notes` / `## Fallbacks` / `## Troubleshooting`. `hasWhatClause`: split description on `—`/`—`/`. `; return first part has ≥3 words and a noun-verb. Line budget: `body.split('\n').length <= 500`. One-level refs: for each reference content, no `[name](references/...)` or `[name](../references/...)` link pointing deeper.
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Keep the pack green mid-plan** — the shared-hygiene loop in `builtin-hygiene.test.ts` runs `validateSkill` on the CURRENT pack, which lacks metadata. Do NOT run `builtin-hygiene.test.ts` until content tasks (6–10) land metadata; run only `compiler.test.ts` + the new gate tests after this task. The pack is "structurally red until Task 6+", and Task 12's full gate is the true green checkpoint.
- [ ] **Step 6: Commit** — `git commit -m "feat(skills): structural quality gate in validateSkill"`

---

### Task 3: `lintSkill` (warnings) + `noir skills lint` CLI

**Files:**
- Modify: `packages/skills/src/compiler.ts` (export `lintSkill`), `packages/skills/src/index.ts`
- Create: `packages/skills/src/lint.ts` (or fold into `quality.ts`)
- Modify: `packages/cli/src/commands/skills.ts` (add `skills lint`), `packages/cli/src/commands/registry.ts` (TUI registry — optional), `packages/cli/test/skills.test.ts`

**Interfaces:**
- Produces: `lintSkill(skill): {name, errors: string[], warnings: string[]}` (errors = validateSkill errors, warnings = soft). CLI `noir skills lint` → `{ok:true, data:{skills:[{name, errors, warnings}]}}`; exit 0 if no errors, 1 if errors; `--json` envelope.

- [ ] **Step 1: Write failing test** — `packages/cli/test/skills.test.ts`:

```ts
it('skills lint reports per-skill errors+warnings with --json', async () => {
  const r = await runCli(['skills', 'lint', '--json']);
  expect(r.status).toBe(0);
  const env = JSON.parse(r.stdout);
  expect(env.ok).toBe(true);
  expect(Array.isArray(env.data.skills)).toBe(true);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (command not found).
- [ ] **Step 3: Implement** — add `lintSkill` to compiler (wraps validateSkill errors + `quality.ts` warnings), export from index, register `skills lint` subcommand in `skills.ts` mirroring `skillsList` structure (in-process, no daemon).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): noir skills lint — structural quality gate CLI"`

---

### Task 4: Runtime-derived registry (`buildRegistry`) + CLI `skills registry --json` + Category/Status columns in `skills list`

**Files:**
- Create: `packages/skills/src/registry.ts`
- Modify: `packages/skills/src/index.ts` (export), `packages/cli/src/commands/skills.ts`, `packages/cli/test/skills.test.ts`
- Test: `packages/skills/test/registry.test.ts` (new)

**Interfaces:**
- Produces:
```ts
export interface SkillRegistryEntry {
  name: string; kind: 'builtin' | 'integration';
  category: string; version: string; status: 'full' | 'stub';
  description: string; referenceCount: number; lines: number;
}
export function buildRegistry(): SkillRegistryEntry[]; // discoverAll() → map; category from metadata.category, fallback derivation; status = !body.includes('> **Stub:**')
```

- [ ] **Step 1: Write failing test** — `registry.test.ts`:

```ts
it('builds a registry from discoverAll with 34 entries', () => {
  const reg = buildRegistry();
  expect(reg.length).toBe(34); // 33 builtins + clickup
  const clickup = reg.find((r) => r.name === 'noir-clickup');
  expect(clickup?.kind).toBe('integration');
  expect(typeof clickup?.category).toBe('string');
  expect(clickup?.status).toBe('full');
});
```

- [ ] **Step 2: Run** — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** — `registry.ts`; export; CLI `skills registry --json` → `{ok:true, data:{count, skills}}`; `skills list` table gains `Category` + `Status` columns (reuse `categoryOf`, now read `metadata.category` first, fallback derivation).
- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(skills): runtime-derived skill registry + CLI query"`

---

### Task 5: Evals harness — `evals/evals.json` + vitest runner + 2 example evals

**Files:**
- Create: `packages/skills/evals/noir-tdd/evals.json`, `packages/skills/evals/noir-debug/evals.json`
- Create: `packages/skills/src/evals.ts` (types + assertion runner)
- Create: `packages/skills/test/evals.test.ts`
- Modify: `packages/skills/src/index.ts` (export), `packages/skills/package.json` (files: add `evals`)

**Interfaces:**
- Produces:
```ts
export interface EvalAssertion { type: 'contains' | 'not-contains' | 'regex' | 'length-gte'; value: string | number; }
export interface SkillEval { id: string; prompt: string; expected_output: string; assertions?: EvalAssertion[]; }
export interface EvalSuite { skill_name: string; evals: SkillEval[]; }
export function runAssertions(output: string, assertions: EvalAssertion[]): { pass: boolean; failures: string[] };
export function loadEvalSuites(dir?: string): EvalSuite[]; // reads evals/**/evals.json
```

- [ ] **Step 1: Write failing test** — `evals.test.ts`:

```ts
it('runs offline assertions', () => {
  const r = runAssertions('Write a failing test first.', [
    { type: 'contains', value: 'failing test' },
    { type: 'not-contains', value: 'implementation first' },
  ]);
  expect(r.pass).toBe(true);
});
it('loads shipped eval suites', () => {
  const suites = loadEvalSuites();
  expect(suites.length).toBeGreaterThanOrEqual(2);
  const tdd = suites.find((s) => s.skill_name === 'noir-tdd');
  expect(tdd?.evals.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — `evals.ts`; write 2 `evals.json` (tdd: red-green-refactor-loop; debug: root-cause-first) with `contains`/`not-contains` assertions; `evals.test.ts` runs all suites offline.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(skills): evals harness (evals.json + vitest runner) + 2 examples"`

---

### Task 6: Content — SDD lifecycle cluster (7 skills) full rewrite

**Files:**
- Modify (rewrite body + frontmatter): `packages/skills/builtin/{noir-intake,noir-clarify,noir-spec,noir-plan,noir-execute,noir-verify,noir-document}/SKILL.md`
- Create: `noir-spec/references/spec-template.md` (1 reference)

**Interfaces:**
- Consumes: Task 2 gate (all must pass `validateSkill` + `lintSkill` warnings ideally ≤2), Task 1 frontmatter.
- Produces: 7 full playbooks (35–60 lines each), WHAT+WHEN descriptions, `metadata.category` in {discovery,spec,plan,execute,verify,document}.

- [ ] **Step 1: Rewrite each SKILL.md** to the canonical template (Overview → When to use → Procedure → Verification → Notes), 35–60 lines, WHAT+WHEN single-line description, metadata+license+compatibility. Follow `noir-debug`/`noir-tdd` as the internal gold standard; no Superpowers rhetoric.
- [ ] **Step 2: Add `noir-spec/references/spec-template.md`** — a concise spec section template (what/why/acceptance/non-goals) that `noir-spec` links to from `## Procedure` (one-level).
- [ ] **Step 3: Validate the cluster** — `pnpm vitest run packages/skills/test/builtin-hygiene.test.ts` (after Task 8 flips the STUBS list) OR a temp check: run a small script asserting each of the 7 validates. Expected: all pass.
- [ ] **Step 4: Commit** — `git commit -m "feat(skills): SDD lifecycle playbooks deepened (intake,clarify,spec,plan,execute,verify,document)"`

---

### Task 7: Content — Power + Session cluster (9 skills)

**Files:**
- Modify: `packages/skills/builtin/{noir-brainstorm,noir-debug,noir-review,noir-tdd,noir-subagent,noir-parallel,noir-sync,noir-checkpoint,noir-explore}/SKILL.md`
- Create: `noir-debug/references/tracing.md`, `noir-review/references/review-checklist.md`, `noir-tdd/references/tdd-worked-example.md` (3 references)

- [ ] **Step 1: Rewrite each** (brainstorm 40–60L, debug 55–80L + ref, review 45–60L + ref, tdd 60–85L + ref, subagent 55–75L, parallel 55–75L, sync 35–45L normalize from Fallbacks, checkpoint 35–45L normalize, explore 35–50L). Normalize `noir-sync`/`noir-checkpoint` to `## Notes` (drop `## Fallbacks`).
- [ ] **Step 2: Add 3 references** — `tracing.md` (evidence-at-boundaries), `review-checklist.md` (acceptance rubric), `tdd-worked-example.md` (RED/GREEN/REFACTOR walkthrough).
- [ ] **Step 3: Validate cluster** — all pass `validateSkill`.
- [ ] **Step 4: Commit** — `git commit -m "feat(skills): power + session playbooks deepened with references"`

---

### Task 8: Content — former stubs cluster A (git + doctor + skill-author + readme)

**Files:**
- Rewrite stub→full: `packages/skills/builtin/{noir-commit,noir-pr,noir-branch,noir-worktree,noir-doctor,noir-skill-author,noir-readme}/SKILL.md`
- Modify: `packages/skills/test/builtin-hygiene.test.ts` (remove these from `STUBS` array, add to full lists; drop the `> **Stub:**` marker assertions; the `22+11` total test becomes `29+4` then `33+0` as tasks land — update to reflect full pack = 33 full + 1 integration at the END, or make the count a `>=` check)

- [ ] **Step 1: Rewrite 7 stubs to full** (commit 35–50L, pr 40–55L, branch 35–45L, worktree 35–50L, doctor 40–55L, skill-author 50–70L meta-skill, readme 35–50L). Each WHAT+WHEN, metadata, canonical template. `noir-skill-author` becomes the pack's authoring style-guide (sections, WHAT+WHEN rule, template, lint).
- [ ] **Step 2: Update the test** — remove the 7 from `STUBS`; move to a full list; the total test asserts `skills.length === 33` and `stubCount === 4` (transitional) — final form after Task 9 is `stubCount === 0`.
- [ ] **Step 3: Validate + run** — `pnpm vitest run packages/skills/test/builtin-hygiene.test.ts` Expected: PASS (with updated counts).
- [ ] **Step 4: Commit** — `git commit -m "feat(skills): former git/doctor/skill-author/readme stubs deepened to full"`

---

### Task 9: Content — former stubs cluster B (domain + test + clickup metadata)

**Files:**
- Rewrite stub→full: `packages/skills/builtin/{noir-frontend,noir-backend,noir-security,noir-test}/SKILL.md`
- Create: `noir-frontend/references/ui-patterns.md`, `noir-backend/references/backend-patterns.md`, `noir-security/references/security-checklist.md`, `noir-test/references/test-design.md` (4 references)
- Modify: `packages/skills/integrations/noir-clickup/SKILL.md` (add metadata category=integration)
- Modify: `packages/skills/test/builtin-hygiene.test.ts` (STUBS → empty; total test → `stubCount === 0`, `skills.length === 33`)

- [ ] **Step 1: Rewrite 4 stubs to full** (frontend 40–60L + ref, backend 40–60L + ref, security 45–60L + ref, test 40–55L + ref).
- [ ] **Step 2: Add 4 references** — UI/backend/security/test patterns (one-level, descriptive).
- [ ] **Step 3: Add `metadata` to clickup** — `category: integration`, `version: 1.0.0`.
- [ ] **Step 4: Update the test** — STUBS now `[]`; assert `skills.length === 33`, `stubCount === 0`, every skill full. This is the acceptance flip: **all 11 stubs deepened**.
- [ ] **Step 5: Validate + run** — full `packages/skills/test/` Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(skills): domain + test stubs deepened; clickup metadata; all 33 full"`

---

### Task 10: Content — polish cluster (prd, rules, wrap, context, recall, remember) normalize template

**Files:**
- Modify: `packages/skills/builtin/{noir-prd,noir-rules,noir-wrap,noir-context,noir-recall,noir-remember}/SKILL.md`

- [ ] **Step 1: Normalize** each to canonical template (prd keeps custom sections but adds Overview + Verification; rules adds Procedure + Notes; wrap `## Steps` → `## Procedure`; context/recall/remember per template). Add WHAT clause to any WHEN-only description; add metadata.
- [ ] **Step 2: Validate** — all pass `validateSkill` + `lintSkill`.
- [ ] **Step 3: Commit** — `git commit -m "feat(skills): normalize remaining playbooks to canonical template"`

---

### Task 11: All 34 descriptions WHAT+WHEN + pack-wide lint clean

**Files:**
- All `packages/skills/builtin/*/SKILL.md` + `integrations/noir-clickup/SKILL.md`

- [ ] **Step 1: Sweep every description** — confirm each is `WHAT sentence. Use when <WHEN>...` single-line, ≤1024 chars, leading WHEN cue preserved (compiler regex). Add WHAT clause where missing (Task 6–10 may have done most).
- [ ] **Step 2: Run the full gate subset** — `pnpm vitest run packages/skills/test/` Expected: all pass.
- [ ] **Step 3: Run `noir skills lint`** — `node packages/cli/dist/bin.js skills lint` (after build) or vitest; confirm zero ERRORS, warnings only where intended (thin-body warnings resolved by rewrites).
- [ ] **Step 4: Commit** — `git commit -m "feat(skills): all descriptions WHAT+WHEN; pack lint clean"`

---

### Task 12: Docs sync — capability-03, STATUS, releases, backlog, ADR-0002, CHANGELOG, reference/skills.md, AGENTS.md

**Files:**
- Modify: `docs/roadmap/capability-03-builtin-skill-system.md`, `docs/roadmap/STATUS.md`, `docs/roadmap/releases.md`, `docs/roadmap/backlog.md`, `docs/decisions/0002-native-skills-only-plugin-removed.md`, `CHANGELOG.md`, `AGENTS.md`, `scripts/docs-generate.mjs` (Category column)
- Test: `pnpm docs:generate` then `pnpm docs:validate`

- [ ] **Step 1: Update `docs-generate.mjs` `genSkillsTable`** — read `metadata.category` from frontmatter (regex `category:\s*(.+)`), render a `Category` column after `Type`.
- [ ] **Step 2: Run `pnpm docs:generate`** — regenerates `docs/reference/skills.md` with Category column + updated descriptions.
- [ ] **Step 3: Update docs** — capability-03 status → Completed + close Done-when criteria; STATUS C3 row → 🟩 Completed + sprint entry; releases current-status block notes C3 completion; backlog — move stubs/references/registry/quality-gate to resolved; ADR-0002 count fix → "33 builtins (all full after C3) + 1 integration"; CHANGELOG add `## [Unreleased] — C3 skills enhancement`; AGENTS.md skill contract adds metadata/quality/registry/evals.
- [ ] **Step 4: Run `pnpm docs:validate`** — Expected: PASS (no broken links / stale refs).
- [ ] **Step 5: Commit** — `git commit -m "docs: C3 completed — capability-03, STATUS, releases, backlog, ADR-0002, CHANGELOG, AGENTS.md, skills reference"`

---

### Task 13: Full gate + cleanup + final commit

**Files:**
- Everything above; cleanup `/tmp` artifacts created this session.

- [ ] **Step 1: Run the full gate** — `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate`
  Expected: ALL GREEN.
- [ ] **Step 2: Fix any failures** — iterate until green (evidence: pasted output).
- [ ] **Step 3: Clean tmp** — `rm -rf` any session scratch under `/tmp/claude-501/...` and the repo; verify `find . -name '*.tmp' -o -name '*~'` empty.
- [ ] **Step 4: Final commit** — `git add -A && git commit -m "chore(skills): C3 complete — full pack, registry, quality gate, evals, docs"` (if uncommitted residue).
- [ ] **Step 5: Report** — summarize what shipped, test counts, gate status; stay on `develop`, no push.

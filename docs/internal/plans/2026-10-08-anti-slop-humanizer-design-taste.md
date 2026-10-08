# Anti-slop + humanizer + design-taste adoption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Noir's always-on rules and skill pack by natively reimplementing the ponytail laziness ladder, anti-slop / humanizer prose standards, and design-taste references, with no third-party text.

**Architecture:** Three tiers. (1) A short anti-slop block in the `RULES.md` seed reaches all five hosts via the existing static `@import`. (2) The claude `SessionStart` hook runner is extended to inject a full ruleset read from a new `.noir/rules/anti-slop.md` artifact. (3) Renamed/new skills and a `references/design.md` inventory carry the playbooks on demand.

**Tech Stack:** TypeScript (ESM), vitest, biome, better-sqlite3 store (untouched). Node 22.x runtime.

**Spec:** `docs/internal/specs/2026-10-08-anti-slop-humanizer-design-taste-design.md`

## Global Constraints

- New and renamed skills keep the `noir-<kebab>` noun canon and the `dir == frontmatter.name` compiler invariant.
- Every rule and every new/renamed skill ships a regression test and an eval (repo rule: every fix = a test).
- Always-on rules respect `rules.enabled`; the static block stays under the 150-line / `lengthBudgetKb` budget.
- No third-party text is shipped; dataviz and the frontend-design mirror are ideas-only.
- Conventional commits, one scope per commit; commits stay local.
- Done = `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate && pnpm hygiene:gate` all green.

## Review Focus

- **Lexical false positives** — a banned word used as a legitimate technical term must not warn. Pin with an allowlist test (`harness`, `unlock`, `elevated`, `journey`).
- **Cluster boundary** — exactly three tier-2 words in one paragraph warn; two stay clean. Pin the boundary.
- **Fenced code is prose-exempt** — a code block containing `robust seamless` yields no slop finding.
- **Hook robustness** — the runner still emits valid `hookSpecificOutput` JSON when `.noir/rules/anti-slop.md` is absent (returns `{}` for that part, never crashes).
- **Rename completeness** — the old name `noir-code-hygiene` appears nowhere in emitted artifacts, while a stale `.noir/rules` or host dir from a prior install is pruned on `noir sync`.

---

## File Structure

**Slice 1 — rule engine (`@noir-ai/skills` + `@noir-ai/cli` scan):**
- Create `packages/skills/src/slop.ts` — lexical anti-slop word/phrase lists + cluster finder.
- Create `packages/skills/src/humanizer.ts` — em-dash density, hedging, not-X-but-Y finder.
- Create `packages/skills/src/debt-marker.ts` — `noir-debt:` marker rule.
- Modify `packages/skills/src/hygiene.ts` — register the new rule families in `HYGIENE_RULES`.
- Modify `packages/cli/src/hygiene-scan.ts` — per-file prose pass that calls the new finders.

**Slice 2 — always-on injection (`@noir-ai/create`):**
- Create `packages/create/templates/anti-slop.md.tmpl` — the full always-on ruleset prose.
- Modify `packages/create/templates/rules-seed.md.tmpl` — append the short always-on block.
- Modify `packages/create/src/manifest.ts` — emit `.noir/rules/anti-slop.md` (regenerate) and extend `SESSION_START_HOOK_SCRIPT` to read it.

**Slice 3 — rename + rework (`@noir-ai/skills`, `@noir-ai/cli`, `@noir-ai/create`):**
- Rename `packages/skills/builtin/noir-code-hygiene` → `noir-codebase-audit`.
- Modify `packages/cli/src/commands/skills.ts` (catalog map), `packages/create/templates/router.md.tmpl`, `rules-seed.md.tmpl`, `packages/skills/evals/noir-code-hygiene/`.
- Rework all 27 builtin bodies to the hardened standard.

**Slice 4 — new skills (`@noir-ai/skills`):**
- Create `builtin/noir-lazy`, `builtin/noir-debt`, `builtin/noir-over-engineering-review`.

**Slice 5 — design skills (`@noir-ai/skills`):**
- Create `builtin/noir-design`, `builtin/noir-design-reference`, `builtin/noir-dataviz`; fold `noir-frontend`.

**Slice 6 — gate, evals, docs:**
- Modify `scripts/hygiene-gate.mjs` (no-op, warns already exit 0), `scripts/docs-generate.mjs` (regenerate skills table).
- Add evals for new/renamed skills; regenerate `docs/reference/skills.md`.

---

## Slice 1 — Rule engine

### Task 1: Lexical anti-slop finder (`slop.ts`)

**Files:**
- Create: `packages/skills/src/slop.ts`
- Create: `packages/skills/test/slop.test.ts`
- Modify: `packages/skills/src/hygiene.ts` (import + re-export, register)

**Interfaces:**
- Produces: `KILL_ON_SIGHT: readonly string[]`, `CLUSTER_WORDS: readonly string[]`, `FILLER_PHRASES: readonly string[]`, `SLOP_TRIGRAMS: readonly string[]`, `SLOP_ALLOWLIST: readonly string[]`, and `slopFindings(text: string): HygieneFinding[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/skills/test/slop.test.ts
import { describe, expect, it } from 'vitest';
import { slopFindings } from '../src/slop.js';

describe('slopFindings', () => {
  it('flags a kill-on-sight word', () => {
    const f = slopFindings('We will leverage this insight.');
    expect(f.map((x) => x.id)).toContain('slop-kill');
  });

  it('flags a paragraph with three cluster words but not two', () => {
    const three = slopFindings('A robust, seamless, and scalable platform.');
    const two = slopFindings('A robust and seamless platform.');
    expect(three.some((x) => x.id === 'slop-cluster')).toBe(true);
    expect(two.some((x) => x.id === 'slop-cluster')).toBe(false);
  });

  it('does not scan fenced code blocks', () => {
    const f = slopFindings('```ts\nconst robust = seamless();\n```');
    expect(f).toEqual([]);
  });

  it('allows legitimate technical uses', () => {
    const f = slopFindings('Unlock the harness for elevated journeys.');
    expect(f).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/skills/test/slop.test.ts`
Expected: FAIL — `Cannot find module '../src/slop.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/skills/src/slop.ts
import type { HygieneFinding } from './hygiene.js';

export const KILL_ON_SIGHT = [
  'delve', 'utilize', 'leverage', 'facilitate', 'elucidate', 'embark', 'endeavor',
  'encompass', 'multifaceted', 'tapestry', 'testament', 'paradigm', 'synergy',
  'holistic', 'catalyze', 'juxtapose', 'realm', 'landscape', 'myriad', 'plethora',
] as const;

export const CLUSTER_WORDS = [
  'robust', 'comprehensive', 'seamless', 'cutting-edge', 'innovative', 'streamline',
  'empower', 'foster', 'enhance', 'elevate', 'optimize', 'scalable', 'pivotal',
  'intricate', 'profound', 'resonate', 'underscore', 'harness', 'navigate',
  'cultivate', 'bolster', 'galvanize', 'cornerstone', 'game-changer',
] as const;

export const FILLER_PHRASES = [
  'it is important to note', "it's important to note", 'it is worth noting',
  'in today\'s', 'in conclusion', 'needless to say',
] as const;

export const SLOP_TRIGRAMS = [
  'a testament to', 'a tapestry of', 'in the realm of', 'the power of',
  'serves as a', 'in order to', 'the fact that', 'plays a crucial',
] as const;

export const SLOP_ALLOWLIST = ['harness', 'unlock', 'elevated', 'journey'] as const;

// Strip fenced code so prose rules never read inside ``` blocks.
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

// Whole words only; case-insensitive.
function wordRe(word: string): RegExp {
  return new RegExp(`\\b${word.replace(/[-']/g, '[-\\s]?')}\\b`, 'i');
}

const CLUSTER_THRESHOLD = 3;

export function slopFindings(text: string): HygieneFinding[] {
  const prose = proseOnly(text);
  const findings: HygieneFinding[] = [];

  for (const word of KILL_ON_SIGHT) {
    if (!SLOP_ALLOWLIST.includes(word) && wordRe(word).test(prose)) {
      findings.push({
        id: 'slop-kill', tier: 'warn', line: 0, text: word,
        rationale: 'a word LLMs overuse, flagged on first use',
        fix: `replace "${word}" with a plain verb or noun`,
      });
    }
  }

  const paragraphs = prose.split(/\n{2,}/);
  for (let i = 0; i < paragraphs.length; i++) {
    const hits = CLUSTER_WORDS.filter((w) => wordRe(w).test(paragraphs[i] ?? '')).length;
    if (hits >= CLUSTER_THRESHOLD) {
      findings.push({
        id: 'slop-cluster', tier: 'warn', line: 0, text: `${hits} cluster words`,
        rationale: 'a paragraph dense with abstract praise reads machine-written',
        fix: 'rewrite in concrete terms; keep at most one such word',
      });
    }
  }

  for (const phrase of [...FILLER_PHRASES, ...SLOP_TRIGRAMS]) {
    if (new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(prose)) {
      findings.push({
        id: 'slop-phrase', tier: 'warn', line: 0, text: phrase,
        rationale: 'a filler phrase or slop trigram',
        fix: 'delete it or state the point directly',
      });
    }
  }

  return findings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/skills/test/slop.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the finder is consumed by the scan (Task 5 wires it); commit**

```bash
git add packages/skills/src/slop.ts packages/skills/test/slop.test.ts
git commit -m "feat(skills): lexical anti-slop finder with cluster threshold"
```

### Task 2: Humanizer finder (`humanizer.ts`)

**Files:**
- Create: `packages/skills/src/humanizer.ts`
- Create: `packages/skills/test/humanizer.test.ts`

**Interfaces:**
- Produces: `humanizerFindings(text: string): HygieneFinding[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/skills/test/humanizer.test.ts
import { describe, expect, it } from 'vitest';
import { humanizerFindings } from '../src/humanizer.js';

describe('humanizerFindings', () => {
  it('flags em-dash density above two per paragraph', () => {
    const f = humanizerFindings('One — two — three — four.');
    expect(f.map((x) => x.id)).toContain('humanizer-em-dash');
  });
  it('flags a hedging opener', () => {
    const f = humanizerFindings('It is worth mentioning that this works.');
    expect(f.map((x) => x.id)).toContain('humanizer-hedge');
  });
  it('flags a not-X-but-Y contrast', () => {
    const f = humanizerFindings('This is not a bug but a feature.');
    expect(f.map((x) => x.id)).toContain('humanizer-contrast');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/skills/test/humanizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/skills/src/humanizer.ts
import type { HygieneFinding } from './hygiene.js';

const HEDGES = ['it is worth mentioning', 'it should be noted', 'it goes without saying', 'arguably'];
const EM_DASH_PER_PARAGRAPH = 2;

export function humanizerFindings(text: string): HygieneFinding[] {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const findings: HygieneFinding[] = [];

  for (const h of HEDGES) {
    if (new RegExp(h, 'i').test(prose)) {
      findings.push({ id: 'humanizer-hedge', tier: 'warn', line: 0, text: h, rationale: 'a hedging opener', fix: 'delete it' });
    }
  }
  if (/\bnot\s+\w+[\w\s,]{0,40}\bbut\b/i.test(prose)) {
    findings.push({ id: 'humanizer-contrast', tier: 'warn', line: 0, text: 'not X but Y', rationale: 'a formulaic contrast', fix: 'state the second clause alone' });
  }
  const paragraphs = prose.split(/\n{2,}/);
  for (const p of paragraphs) {
    const count = (p.match(/—/g) ?? []).length;
    if (count > EM_DASH_PER_PARAGRAPH) {
      findings.push({ id: 'humanizer-em-dash', tier: 'warn', line: 0, text: `${count} em-dashes`, rationale: 'em-dash density is an AI tell', fix: 'use periods or parentheticals' });
    }
  }
  return findings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/skills/test/humanizer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/humanizer.ts packages/skills/test/humanizer.test.ts
git commit -m "feat(skills): humanizer tells finder (em-dash, hedging, contrast)"
```

### Task 3: Debt marker rule (`debt-marker.ts`)

**Files:**
- Create: `packages/skills/src/debt-marker.ts`
- Create: `packages/skills/test/debt-marker.test.ts`

**Interfaces:**
- Produces: `DEBT_MARKER_RULE: HygieneRule` (id `noir-debt`, code kind, warn).

- [ ] **Step 1: Write the failing test**

```ts
// packages/skills/test/debt-marker.test.ts
import { describe, expect, it } from 'vitest';
import { DEBT_MARKER_RULE } from '../src/debt-marker.js';

const flag = (line: string) => DEBT_MARKER_RULE.pattern.test(line);

describe('noir-debt marker', () => {
  it('matches a debt marker line', () => {
    expect(flag('// noir-debt: global lock, per-account locks when throughput matters')).toBe(true);
  });
  it('requires an upgrade trigger', () => {
    expect(flag('// noir-debt: global lock')).toBe(false);
  });
  it('stays off ordinary prose', () => {
    expect(flag('the noir-debt ledger was full')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/skills/test/debt-marker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/skills/src/debt-marker.ts
import type { HygieneRule } from './hygiene.js';

// A `noir-debt:` comment must name both a known ceiling and an upgrade trigger,
// otherwise the deliberate shortcut is un-trackable and rots into "later means never".
export const DEBT_MARKER_RULE: HygieneRule = {
  id: 'noir-debt',
  tier: 'warn',
  appliesTo: 'code',
  pattern: /(?:^[ \t]*|[ \t])(?:\/\/|#|\*)\s*noir-debt:(?!.*\b(?:when|if|ceiling|ceiling:|once)\b)/,
  rationale: 'a debt marker without a ceiling or upgrade trigger is an un-trackable shortcut',
  fix: 'name the ceiling and the condition that justifies the upgrade',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/skills/test/debt-marker.test.ts`
Expected: PASS.

- [ ] **Step 5: Register in `hygiene.ts` and commit**

In `packages/skills/src/hygiene.ts`, import `DEBT_MARKER_RULE` and append it to `HYGIENE_RULES`. Mark the module `// noir-hygiene: exempt` if it names a banned shape.

```bash
git add packages/skills/src/debt-marker.ts packages/skills/test/debt-marker.test.ts packages/skills/src/hygiene.ts
git commit -m "feat(skills): noir-debt marker rule with ceiling+trigger requirement"
```

### Task 4: Wire finders into the scan

**Files:**
- Modify: `packages/cli/src/hygiene-scan.ts`
- Modify: `packages/cli/test/doctor-hygiene.test.ts`

**Interfaces:**
- Consumes: `slopFindings`, `humanizerFindings` from `@noir-ai/skills`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/doctor-hygiene.test.ts — add one case to the existing describe
it('reports a prose slop finding and a humanizer finding', async () => {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'x.md'), 'We will leverage a robust seamless scalable platform — and — and —.\n');
  const res = await scanOutputHygiene(root);
  const ids = res.findings.map((f) => f.id);
  expect(ids).toContain('slop-kill');
  expect(ids).toContain('slop-cluster');
  expect(ids).toContain('humanizer-em-dash');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/test/doctor-hygiene.test.ts -t 'prose slop'`
Expected: FAIL — the new ids are absent.

- [ ] **Step 3: Implement the prose pass in `hygiene-scan.ts`**

For each markdown file, after the existing `checkHygiene(text, 'markdown')` call, add:

```ts
findings.push(...slopFindings(text), ...humanizerFindings(text));
```

Import both finders from `@noir-ai/skills`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/test/doctor-hygiene.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/hygiene-scan.ts packages/cli/test/doctor-hygiene.test.ts
git commit -m "feat(cli): scan prose for lexical slop and humanizer tells"
```

---

## Slice 2 — Always-on injection

### Task 5: Always-on ruleset templates

**Files:**
- Create: `packages/create/templates/anti-slop.md.tmpl`
- Modify: `packages/create/templates/rules-seed.md.tmpl`
- Modify: `packages/create/test/rules-seed.test.ts`

**Interfaces:**
- Produces: a full ruleset template and a short block appended to the seed.

- [ ] **Step 1: Write the failing test**

```ts
// packages/create/test/rules-seed.test.ts — add
it('the seed carries the short always-on anti-slop block', () => {
  const seed = loadTemplate('rules-seed.md.tmpl');
  expect(seed).toContain('anti-slop');
  expect(seed).toContain('delete filler phrases');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/create/test/rules-seed.test.ts`
Expected: FAIL — the block is absent.

- [ ] **Step 3: Write the templates**

`rules-seed.md.tmpl` — append (no banners, plain markdown, under 40 lines):

```markdown
## Anti-slop

Prefer plain verbs and concrete nouns. Do not use: delve, utilize, leverage, facilitate,
elucidate, embark, endeavor, encompass, multifaceted, tapestry, testament, paradigm,
synergy, holistic, catalyze, juxtapose, realm, landscape, myriad, plethora.

Use at most one of these per paragraph: robust, comprehensive, seamless, cutting-edge,
innovative, streamline, empower, foster, enhance, elevate, optimize, scalable, pivotal,
intricate, profound, resonate, underscore, navigate, cultivate, bolster, galvanize,
cornerstone, game-changer.

Delete filler phrases (it is important to note that, needless to say) and slop trigrams
(a testament to, in the realm of, serves as a). Write the claim, not the frame.

Keep em-dashes to at most two per paragraph. Avoid the not-X-but-Y contrast.
```

`anti-slop.md.tmpl` — the full ruleset: the lists above plus the laziness ladder (the seven
rungs, YAGNI, reuse-before-write, delete-over-add, root-cause-not-symptom, the
`noir-debt:` ceiling-and-trigger contract), each as a short prose block.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/create/test/rules-seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/create/templates/anti-slop.md.tmpl packages/create/templates/rules-seed.md.tmpl packages/create/test/rules-seed.test.ts
git commit -m "feat(create): always-on anti-slop ruleset templates"
```

### Task 6: Emit `.noir/rules/anti-slop.md` + extend the hook runner

**Files:**
- Modify: `packages/create/src/manifest.ts`
- Modify: `packages/create/test/scaffold.test.ts`

**Interfaces:**
- Consumes: `loadTemplate('anti-slop.md.tmpl')`.
- Produces: a regenerate manifest entry for `.noir/rules/anti-slop.md`; a hook runner that reads it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/create/test/scaffold.test.ts — add
it('claude init emits .noir/rules/anti-slop.md and the runner reads it', async () => {
  await scaffold({ root, mode: 'init', transport: 'stdio', host: 'claude' });
  const rules = join(root, '.noir', 'rules', 'anti-slop.md');
  expect(existsSync(rules)).toBe(true);
  const out = execSync(`node "${join(root, '.noir', 'hooks', 'noir-session-start.mjs')}"`).toString();
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.additionalContext).toContain('anti-slop');
});
```

(Add `execSync` to the `node:child_process` import at the top of the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/create/test/scaffold.test.ts -t 'anti-slop'`
Expected: FAIL — the file is absent / the hook output lacks it.

- [ ] **Step 3: Implement**

In `manifest.ts`, in the claude-only hook block (near the router entry), add a regenerate entry:

```ts
entries.push({
  path: '.noir/rules/anti-slop.md',
  mode: 'regenerate',
  host,
  content: loadTemplate('anti-slop.md.tmpl'),
  description: 'always-on anti-slop + laziness ruleset (hook-injected, not @imported)',
});
```

Extend `SESSION_START_HOOK_SCRIPT` so `main()` also reads `.noir/rules/anti-slop.md` and
appends it to the `additionalContext` string (separated from the router contract by a
blank line). If the file is absent, append nothing. Wrap the extra read in the existing
try/catch style so a missing file never crashes the hook.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/create/test/scaffold.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/create/src/manifest.ts packages/create/test/scaffold.test.ts
git commit -m "feat(create): inject always-on anti-slop ruleset via the SessionStart hook"
```

---

## Slice 3 — Rename + rework

### Task 7: Rename `noir-code-hygiene` → `noir-codebase-audit`

**Files:**
- Rename: `packages/skills/builtin/noir-code-hygiene/` → `packages/skills/builtin/noir-codebase-audit/` (update frontmatter `name` and the H1; merge in audit/debt/anti-slop content).
- Modify: `packages/cli/src/commands/skills.ts` (catalog map).
- Modify: `packages/create/templates/router.md.tmpl` (add routing), `rules-seed.md.tmpl` (rename the reference).
- Rename: `packages/skills/evals/noir-code-hygiene/` → `packages/skills/evals/noir-codebase-audit/`.
- Modify: `packages/skills/test/builtin-hygiene-skill.test.ts`, `evals-real-output.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/skills/test/builtin-hygiene-skill.test.ts — replace name assertions
expect(builtins.map((b) => b.name)).toContain('noir-codebase-audit');
expect(builtins.map((b) => b.name)).not.toContain('noir-code-hygiene');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/skills/test/builtin-hygiene-skill.test.ts`
Expected: FAIL — old name present, new name absent.

- [ ] **Step 3: Perform the rename atomically**

`git mv` the dir, edit `name:` and the H1, update the catalog map string, the router/seed
references, the evals dir, and the test expectations. Grep the whole repo for
`noir-code-hygiene` and clear every remaining occurrence except the CHANGELOG/roadmap
(historical — left as-is).

- [ ] **Step 4: Run tests + gate to verify**

Run: `pnpm vitest run packages/skills/test packages/create/test` then the full gate.
Expected: PASS; `pnpm docs:generate` regenerates the skills table with the new name.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(skills): rename noir-code-hygiene to noir-codebase-audit"
```

### Task 8: Rework all 27 builtin bodies to the hardened standard

**Files:** every `packages/skills/builtin/*/SKILL.md` and their `references/`.

- [ ] **Step 1: Define the pass (apply mechanically to each file)**

For each builtin: description leads with a WHEN cue and ends with a do-not boundary;
remove decorative banners, emoji, unbroken comment blocks, and internal jargon; keep each
body under 100 lines; ensure the body passes `noir skills lint` (which now enforces the
new lexical + humanizer + debt rules). Update `noir-codebase-audit` to carry the merged
audit/debt/anti-slop/humanizer playbook.

- [ ] **Step 2: Run the lint gate to confirm the standard is met**

Run: `pnpm vitest run packages/skills/test` and `noir skills lint` via `pnpm build && node packages/cli/dist/index.js skills lint` (or the in-repo equivalent).
Expected: zero fail-tier findings; warn-tier only where a reference must name a banned word (those carry the `noir-hygiene: exempt` marker).

- [ ] **Step 3: Commit (one commit for the content pass)**

```bash
git add packages/skills/builtin
git commit -m "docs(skills): rework builtin bodies to the anti-slop and humanizer standard"
```

---

## Slice 4 — New skills

### Task 9: `noir-lazy`

**Files:** Create `packages/skills/builtin/noir-lazy/SKILL.md` (+ `references/` if needed).

Body (original prose, no third-party text): the laziness ladder — YAGNI first, reuse what
exists, stdlib over deps, one line over fifty, delete over add, root-cause-not-symptom —
with WHEN triggers (`be lazy`, `simplest solution`, `do less`, `yagni`) and a do-not
boundary (non-coding requests). Under 80 lines.

- [ ] **Step 1: Write the failing eval/test** — assert the skill passes `validateSkill` and `lintSkill` and its description leads with a WHEN cue.
- [ ] **Step 2: Run to verify it fails** (module absent).
- [ ] **Step 3: Write the skill body.**
- [ ] **Step 4: Run `pnpm vitest run packages/skills/test` — PASS.**
- [ ] **Step 5: Commit** `feat(skills): noir-lazy laziness-ladder skill`.

### Task 10: `noir-debt` + `noir-over-engineering-review`

**Files:** Create `packages/skills/builtin/noir-debt/SKILL.md` and
`packages/skills/builtin/noir-over-engineering-review/SKILL.md`.

`noir-debt`: harvest `noir-debt:` markers into a ledger (stdout first; a `.noir/`
artifact later), grouped by file with ceiling + trigger. `noir-over-engineering-review`:
diff-scoped complexity review — reinvented stdlib, unneeded deps, speculative abstractions,
dead flexibility — one line per finding. Follow the same test/commit rhythm as Task 9, with
a boundary that keeps both distinct from `noir-exploring`, `noir-doctor`, `noir-verifying`.

---

## Slice 5 — Design skills

### Task 11: `noir-design` + `noir-design-reference`

**Files:**
- Create `packages/skills/builtin/noir-design/SKILL.md` (direction: commit to one bold
  aesthetic; anti-template cliché list; precedence ladder) and fold `noir-frontend` into it
  (delete `builtin/noir-frontend`, migrate its `references/ui-patterns.md`).
- Create `packages/skills/builtin/noir-design-reference/SKILL.md` + `references/design.md`.

`references/design.md` (original content) holds: the style taxonomy (neobrutalism,
glassmorphism, neumorphism, claymorphism, skeuomorphism, minimalism, brutalism, bento
grid, editorial, luxury, plus the ui-ux-pro-max long-tail) each with era/keywords/cost/
accessibility-floor; the 16-token palette schema; the 10-category UX rule ladder with
concrete thresholds; font-pairing and motion guidance. No binary assets; big fonts/icons
are named as pointers.

- [ ] **Step 1: Write the failing test** — `builtins` contain `noir-design` and `noir-design-reference`; `noir-frontend` is gone; `references/design.md` mentions `neobrutalism`, `glassmorphism`, `neumorphism`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Write the skills + reference.**
- [ ] **Step 4: Run `pnpm vitest run packages/skills/test packages/create/test` — PASS.**
- [ ] **Step 5: Commit** `feat(skills): design direction + style reference inventory`.

### Task 12: `noir-dataviz`

**Files:** Create `packages/skills/builtin/noir-dataviz/SKILL.md` + `references/`.

Original rules re-expressing the dataviz ideas (no copied text): color comes last; four
color jobs (categorical/ordinal/sequential/diverging); OKLCH light/dark ranges; CVD
delta-E floor; mark grammar (bar width, line weight, marker size); accessibility twin
(table view per chart). Same test/commit rhythm.

---

## Slice 6 — Gate, evals, docs

### Task 13: Evals + docs sync + full gate

**Files:**
- Add `packages/skills/evals/<new-skill>/evals.json` for every new/renamed skill (format
  `{ skill_name, evals: [...] }`, matching `packages/skills/src/evals.ts`).
- Modify `packages/skills/test/evals-real-output.test.ts` if it enumerates evals.

- [ ] **Step 1: Add evals; run `pnpm vitest run packages/skills/test/evals-real-output.test.ts` — PASS.**
- [ ] **Step 2: Regenerate docs** — `pnpm docs:generate` (regenerates `docs/reference/skills.md`).
- [ ] **Step 3: Full gate** — `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate && pnpm hygiene:gate` all green.
- [ ] **Step 4: Commit** `chore(skills): evals + docs sync for the anti-slop and design adoption`.

---

## Self-review

- **Spec coverage:** slices map 1:1 to the spec's six slices; the three-tier architecture,
  per-host map, rule families, skill changes, design inventory, and constraints each have a
  task. The follow-up (native hooks for cursor/opencode/gemini) is explicitly out of scope,
  matching the spec.
- **Type consistency:** `slopFindings`/`humanizerFindings` return `HygieneFinding[]` from
  `hygiene.ts` in every task; `DEBT_MARKER_RULE` is a `HygieneRule`; the manifest entry uses
  `loadTemplate`, matching Task 6's import.
- **Review Focus:** each line is pinned — allowlist (Task 1), cluster boundary (Task 1),
  fenced-code exemption (Task 1), hook robustness (Task 6), rename completeness (Task 7).

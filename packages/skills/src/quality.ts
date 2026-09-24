// Structural quality checks for the builtin skill pack — the artifact
// quality gate.
//
// Split from compiler.ts so `validateSkill` (hard errors) and `lintSkill` (soft
// warnings) share one source of truth for the body-structure rules, and so the
// rules are unit-testable in isolation. Canonical template:
//
//   Overview → When to use → Procedure → Verification → Notes
//
// Rules here implement the researched canon (Anthropic best practices, the
// agentskills.io spec, Claude Code docs): required sections, a <500-line body
// budget, one-level-deep references (no chained refs), and a WHAT+WHEN
// description. `checkRequiredSections` is the load-bearing check — it's what
// forces every SKILL.md to carry a real playbook shape, not a shell.

import { ARTIFACT_TYPES } from '@noir-ai/core';
import { checkHygiene, HYGIENE_EXEMPT_MARKERS, type HygieneFinding } from './hygiene.js';
import type { BuiltinSkill } from './types.js';

/** The SKILL.md body — the markdown after the YAML frontmatter block. The
 *  frontmatter is metadata the host reads on its own; the body is the playbook
 *  a reader loads. The validator and the lint rules both measure this string,
 *  so it lives here (single source of truth) rather than in compiler.ts. */
export function bodyOf(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** The max body length the canon recommends (Anthropic: "under 500 lines").
 *  SKILL.md is a navigator, not a repository — split to references/ past this. */
export const MAX_BODY_LINES = 500;

/** The floor for a full (non-stub) playbook body. Stubs were ~13 lines; a real
 *  playbook needs at least this much substance to be loadable as guidance. */
export const MIN_FULL_BODY_LINES = 20;

/** The canonical heading a skill MUST carry to describe its trigger conditions.
 *  Accepts the canonical template spelling AND common variants so existing skills
 *  aren't forced into a single casing. */
const WHEN_SECTION = /^## When to use$/im;

/** The canonical heading a skill MUST carry for its numbered workflow. `## Steps`
 *  is accepted for backward-compat with noir-wrap; `## Procedure` is canonical. */
const PROCEDURE_SECTION = /^## (Procedure|Steps)$/im;

/** One of these closing sections must exist — evidence/notes/degradation. */
const CLOSING_SECTION = /^## (Verification|Notes|Fallbacks|Troubleshooting|Why order matters)$/im;

/** The lead cue regex — the FIRST part of the description must be a trigger. */
const WHEN_CUE =
  /^(use|using|used|whenever|when|before|after|while|starting|encountering|completing|creating|about to|upon|during|to|for|on)\b/i;

/** A chained reference link — a reference file that links to ANOTHER reference
 *  file (`references/a.md` → `references/b.md` or `../references/b.md`). The
 *  canon forbids deep nesting (agentskills.io: "no chained references"). */
const CHAINED_REF_RE = /\]\((\/?\.?\.?\/)?(references\/|\.\.\/references\/)/i;

/**
 * Which required sections are missing from a skill body. Returns a list of
 * human-readable section names, e.g. `['## When to use', '## Verification']`.
 * Empty array = the body carries the canonical playbook shape.
 */
export function missingSections(body: string): string[] {
  const missing: string[] = [];
  if (!WHEN_SECTION.test(body)) missing.push('## When to use');
  if (!PROCEDURE_SECTION.test(body)) missing.push('## Procedure (or ## Steps)');
  if (!CLOSING_SECTION.test(body)) {
    missing.push('one of ## Verification / ## Notes / ## Fallbacks / ## Troubleshooting');
  }
  return missing;
}

/** True when the body is within the canon line budget. */
export function withinLineBudget(body: string, max: number = MAX_BODY_LINES): boolean {
  return body.split('\n').length <= max;
}

/** Reference files that point at another reference file (chained — forbidden).
 *  Returns the offending reference names. */
export function chainedReferences(skill: BuiltinSkill): string[] {
  return skill.references.filter((r) => CHAINED_REF_RE.test(r.content)).map((r) => r.name);
}

/**
 * True when the description carries BOTH a WHEN trigger lead AND a WHAT clause.
 * The rule: `description` MUST lead with a WHEN cue (existing compiler rule)
 * AND contain a compact WHAT clause naming what the skill does.
 *
 * Two canonical shapes both pass:
 *   "Use when turning an idea into a spec — draft the spec."   (WHEN → WHAT)
 *   "Use when a task writes back to ClickUp: update its status."  (WHEN → WHAT)
 * The description MUST lead with a cue (the WHEN-only and WHAT-only schools are
 * both rejected). The WHAT clause is the part after the trigger phrase — split
 * on an em/en dash or a period that ends the trigger phrase. A real WHAT clause
 * has ≥3 words naming the action, so a bare "Use when…" fails.
 */
export function isWhatWhenDescription(description: string): boolean {
  const trimmed = description.trim();
  if (!trimmed) return false;
  if (!WHEN_CUE.test(trimmed)) return false; // must lead with a cue
  // Split off the trigger phrase: after an em/en dash, or after the first period.
  // "Use when X — draft the spec." → whatPart = "draft the spec."
  const whatPart = trimmed
    .split(/[—–]|(?<=\.) /)
    .slice(1)
    .join(' ')
    .trim();
  return whatPart.split(/\s+/).filter(Boolean).length >= 3;
}

/** True when the description leads with a WHEN cue (the existing rule, kept
 *  here so validate + lint + hygiene share one implementation). */
export function looksLikeWhenDescription(description: string): boolean {
  return WHEN_CUE.test(description.trim());
}

/**
 * Soft-quality warnings for `lintSkill`. Each returns a short rule id + message.
 * These are advisory — a skill can pass `validateSkill` and still carry lint
 * warnings that the author should resolve. Rules are drawn from the researched
 * anti-pattern list (no examples, thin body, first/second person narration,
 * voodoo constants, time-sensitive version pins).
 */
export function lintWarnings(skill: BuiltinSkill): string[] {
  const warnings: string[] = [];
  // The two body rules below measure the body, not the file: a long description
  // (or any other frontmatter line) must not make a short body look substantial,
  // and a cue in the description must not stand in for a worked example. The
  // prose checks after them read the whole file, so a first-person phrase or a
  // stale version pin is surfaced wherever it sits.
  const file = skill.skillMd;
  const body = bodyOf(file);
  const bodyLines = body.split('\n').length;

  if (bodyLines < MIN_FULL_BODY_LINES) {
    warnings.push('thin-body: full playbook body is under 20 lines');
  }
  // Concrete examples: at least one fenced block or an "example:" mention in
  // the body.
  const hasExample = /```/.test(body) || /\bexample:?\b/i.test(body) || /\be\.g\.\b/i.test(body);
  if (!hasExample) {
    warnings.push('no-example: no concrete code fence or worked example in the body');
  }
  // First/second-person narration — "I/we/you" as the agent doing work.
  if (
    /\b(I|we|you)\s+(will|should|can|need|must|do|write|create|implement|run|build)\b/i.test(file)
  ) {
    warnings.push('first-person: narration addresses the reader instead of imperative steps');
  }
  // Voodoo constants: a bare number with a magnitude claim but no justification
  // ("wait 5 seconds" without why). Very loose — catches "wait N seconds" without
  // a "why".
  if (
    /\b(?:wait|sleep|retry|backoff|limit|cap)\s+[a-z]*\s*(\d{1,4})\b/i.test(file) &&
    !/because|to (avoid|prevent|give|let)/i.test(file)
  ) {
    warnings.push('voodoo-constant: numeric threshold without a stated reason');
  }
  // Time-sensitive version pins outside a Legacy section.
  const hasVersionPin = /as of \d{4}|\bversion \d+\.\d+\.\d+\b|"v\d+\.\d+"/i.test(file);
  const hasLegacySection = /^## Legacy|^## Old patterns/i.test(file);
  if (hasVersionPin && !hasLegacySection) {
    warnings.push('time-sensitive: version/date pin outside a Legacy section');
  }
  return warnings;
}

/** `.noir/` subdirectories a skill may legitimately reference that are NOT
 *  per-type artifact dirs (store db, audit export, rules, daemon state). */
const NON_ARTIFACT_DIRS = new Set(['store', 'audit', 'rules', 'state']);

/** Canonical artifact directory → its type code(s) (from the artifact registry).
 *  One directory can host multiple kinds (`subagents/` → BR + RP). */
const DIR_TO_CODES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const t of Object.values(ARTIFACT_TYPES)) {
    const codes = m.get(t.dir);
    if (codes) codes.add(t.code);
    else m.set(t.dir, new Set([t.code]));
  }
  return m;
})();

/**
 * `.noir/…` output-path drift: a skill body or reference that names a `.noir/`
 * directory absent from the artifact registry (e.g. `.noir/sdd/`), or a file
 * under a canonical artifact directory whose name carries none of that
 * directory's type codes (e.g. `.noir/plans/<date>-<slug>.md` instead of
 * `PL-<NNNN>-…`). Hard errors — the host would mint non-standard artifacts.
 * See `docs/reference/artifact-format.md`.
 */
export function artifactPathDrift(skill: BuiltinSkill): string[] {
  const texts = [skill.skillMd, ...skill.references.map((r) => r.content)];
  const drifts = new Set<string>();
  // `.noir/<dir>/<name>` — name runs to whitespace/backtick/quote/paren so
  // `<date>-<slug>.md` placeholders are captured whole.
  const re = /\.noir\/([a-zA-Z0-9-]+)\/([^\s`'"()]+)/g;
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const dir = m[1];
      const name = m[2];
      if (!dir || !name) continue;
      const codes = DIR_TO_CODES.get(dir);
      if (codes === undefined) {
        if (!NON_ARTIFACT_DIRS.has(dir)) {
          drifts.add(
            `.noir/${dir}/ is not a canonical artifact directory (see docs/reference/artifact-format.md)`,
          );
        }
        continue;
      }
      const expected = [...codes].join('/');
      if (![...codes].some((c) => name.startsWith(`${c}-`))) {
        drifts.add(
          `.noir/${dir}/${name} must be ${expected}-<NNNN>-… (see docs/reference/artifact-format.md)`,
        );
      }
    }
  }
  return [...drifts];
}

// ---------------------------------------------------------------------------
// Output hygiene (the rules live in hygiene.ts).
//
// A SKILL.md body is a markdown document that also carries fenced code blocks,
// so each part is checked with the kind of text it is: the prose as markdown,
// the fenced blocks as source. Checking the whole body as one kind misfires in
// both directions — a source rule reads markdown bold (`**text**`) as a block
// comment, and a prose rule reads a `//` line inside a fence as a heading.
// The fail tier blocks emission and the warn tier is advisory; which findings
// go to which list is `validateSkill`'s decision, not this module's.
// ---------------------------------------------------------------------------

/** A body split into the two kinds of text it holds: the prose, and the fenced
 *  code blocks. Blanking the other side's lines, rather than dropping them,
 *  keeps every finding on the line number it has in the body.
 *
 *  Fences follow the CommonMark rule: a line opening with a run of at least
 *  three backticks or tildes opens a block, and only a run of the same
 *  character at least as long closes it — a shorter run of the same character
 *  (or the other character) inside the block is content, so a block that
 *  documents a fenced example stays one block. An unclosed fence runs to the
 *  end of the body, which is where CommonMark renders its content too. */
function splitFencedBlocks(body: string): { prose: string; code: string } {
  const prose: string[] = [];
  const code: string[] = [];
  // The closing fence of the block currently open: same character, at least the
  // opening run's length, with only whitespace after it. Null when not in a
  // fence.
  let closing: RegExp | null = null;
  for (const line of body.split('\n')) {
    let boundary = false;
    if (closing === null) {
      const open = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      const run = open?.[1];
      if (run) {
        const char = run[0] ?? '';
        closing = new RegExp(`^[ \\t]{0,3}${char}{${run.length},}[ \\t]*$`);
        boundary = true;
      }
    } else if (closing.test(line)) {
      closing = null;
      boundary = true;
    }
    // The fence markers themselves are document syntax; the lines between them
    // are source.
    const isCode = closing !== null && !boundary;
    prose.push(isCode ? '' : line);
    code.push(isCode ? line : '');
  }
  return { prose: prose.join('\n'), code: code.join('\n') };
}

/** The 1-based line the body's exemption marker sits on, or 0 when it carries
 *  none. A SKILL.md body states its own exemption with the markdown marker. */
function exemptionLine(body: string): number {
  const marker = HYGIENE_EXEMPT_MARKERS.markdown;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === marker) return i + 1;
  }
  return 0;
}

/** Every hygiene finding a skill body produces, in reading order.
 *
 *  A body that carries the exemption marker above its first finding is exempt
 *  in both kinds. The marker is a statement about the file, and a body is one
 *  file even though it is read as prose and as source — a fenced code block
 *  cannot carry the document's marker, so without this the code rules would
 *  keep firing inside a body that declared itself exempt. */
export function hygieneFindings(body: string): HygieneFinding[] {
  const { prose, code } = splitFencedBlocks(body);
  const findings = [...checkHygiene(prose, 'markdown'), ...checkHygiene(code, 'code')];
  const seen = new Set<string>();
  const ordered = findings
    .filter((f) => {
      const key = `${f.id}:${f.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
  const exemptAt = exemptionLine(body);
  if (exemptAt !== 0 && exemptAt < (ordered[0]?.line ?? Number.POSITIVE_INFINITY)) return [];
  return ordered;
}

/** One hygiene finding as a gate message: the rule that fired, the line it
 *  fired on, why that line is noise, and what to write instead. */
export function hygieneMessage(finding: HygieneFinding): string {
  return `${finding.id} (line ${finding.line}): ${finding.rationale} ${finding.fix}`;
}

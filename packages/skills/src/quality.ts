// Structural quality checks for the builtin skill pack — the C3 quality gate.
//
// Split from compiler.ts so `validateSkill` (hard errors) and `lintSkill` (soft
// warnings) share one source of truth for the body-structure rules, and so the
// rules are unit-testable in isolation. Canonical template (C3 spec §3):
//
//   Overview → When to use → Procedure → Verification → Notes
//
// Rules here implement the researched canon (Anthropic best practices, the
// agentskills.io spec, Claude Code docs): required sections, a <500-line body
// budget, one-level-deep references (no chained refs), and a WHAT+WHEN
// description. `checkRequiredSections` is the load-bearing check — it's what
// forces every SKILL.md to carry a real playbook shape, not a shell.

import type { BuiltinSkill } from './types.js';

/** The max body length the canon recommends (Anthropic: "under 500 lines").
 *  SKILL.md is a navigator, not a repository — split to references/ past this. */
export const MAX_BODY_LINES = 500;

/** The floor for a full (non-stub) playbook body. Stubs were ~13 lines; a real
 *  playbook needs at least this much substance to be loadable as guidance. */
export const MIN_FULL_BODY_LINES = 20;

/** The canonical heading a skill MUST carry to describe its trigger conditions.
 *  Accepts the C3 template spelling AND common variants so existing skills
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
 * The C3 rule: `description` MUST lead with a WHEN cue (existing compiler rule)
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
  const body = skill.skillMd; // linting the whole file (frontmatter + body) is fine for prose checks
  const bodyLines = body.split('\n').length;

  if (bodyLines < MIN_FULL_BODY_LINES + 6) {
    // frontmatter is ~6 lines; a full playbook should clear 20 body lines
    warnings.push('thin-body: full playbook body is under 20 lines');
  }
  // Concrete examples: at least one fenced block or an "example:" mention.
  const hasExample = /```/.test(body) || /\bexample:?\b/i.test(body) || /\be\.g\.\b/i.test(body);
  if (!hasExample) {
    warnings.push('no-example: no concrete code fence or worked example in the body');
  }
  // First/second-person narration — "I/we/you" as the agent doing work.
  if (
    /\b(I|we|you)\s+(will|should|can|need|must|do|write|create|implement|run|build)\b/i.test(body)
  ) {
    warnings.push('first-person: narration addresses the reader instead of imperative steps');
  }
  // Voodoo constants: a bare number with a magnitude claim but no justification
  // ("wait 5 seconds" without why). Very loose — catches "wait N seconds" without
  // a "why".
  if (
    /\b(?:wait|sleep|retry|backoff|limit|cap)\s+[a-z]*\s*(\d{1,4})\b/i.test(body) &&
    !/because|to (avoid|prevent|give|let)/i.test(body)
  ) {
    warnings.push('voodoo-constant: numeric threshold without a stated reason');
  }
  // Time-sensitive version pins outside a Legacy section.
  const hasVersionPin = /as of \d{4}|\bversion \d+\.\d+\.\d+\b|"v\d+\.\d+"/i.test(body);
  const hasLegacySection = /^## Legacy|^## Old patterns/i.test(body);
  if (hasVersionPin && !hasLegacySection) {
    warnings.push('time-sensitive: version/date pin outside a Legacy section');
  }
  return warnings;
}

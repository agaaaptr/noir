// draft.ts — bounded PRD drafting helper (debt-batch A, slice P).
//
// The PRD is the pre-SDD product artifact (`.noir/prd/<taskId>-<slug>.md`) the
// spec later `@import`s. This helper drafts it from the intake + clarification
// Q&A + retrieved memory via ONE bounded `complete()` call (blueprint D5 —
// single-shot, no tools/stream, provider-EXPLICIT). It mirrors the structure
// the `noir-prd` skill documents (Problem · Evidence · Audience · Success
// Criteria · Appetite/Mode · Proposed Direction · No-gos · Rabbit holes · Open
// Questions) so a model-drafted PRD drops cleanly into the artifact the skill
// writes via `@noir-ai/workflow`'s `writePrd`.
//
// Graceful degradation is FIRST-CLASS: when `complete()` returns `null`
// (no provider configured, or a keyed provider's env var is missing) `draftPrd`
// returns `null` too and the caller substitutes {@link PRD_FALLBACK_TEMPLATE}.
// This is the always-available offline path — the full Noir test suite runs
// with zero network. `draftPrd` itself NEVER throws; an attempted-call failure
// (`{ ok: false }`) is surfaced to the caller as `null` after a structured
// miss, distinct from a clean offline `null` only at the call site (the
// caller's substitution is identical — the template — but a future miss-audit
// sink can distinguish them).
//
// `draftSpec` (the sibling this mirrors) does NOT exist yet in @noir-ai/model —
// slice P ships `draftPrd` first because the PRD is the new artifact kind; the
// spec draft helper lands later and will follow the SAME shape (single bounded
// `complete()` call, `string | null`, section template constant).

import { complete } from './complete.js';
import type { CompleteRequest, ModelConfig } from './types.js';

/**
 * The inputs to a PRD draft — the same three signals the `noir-prd` skill
 * grounds in before drafting. `memory` is RETRIEVED context (never fabricated);
 * `clarify` is resolved clarification Q&A; `intake` is the raw intake notes.
 */
export interface DraftPrdInput {
  /** Raw intake notes (typically `.noir/intake/<taskId>.md`). Required. */
  intake: string;
  /** Resolved clarification Q&A, one entry per line (optional). */
  clarify?: string[];
  /** Retrieved memory context (optional; never fabricated — Evidence needs a source). */
  memory?: string;
}

/**
 * Options for a PRD draft call. `provider` + `model` are EXPLICIT (blueprint D5
 * — the provider is never inferred from env-var presence). `signal`
 * bounds wall-clock further; there is never a stream to cancel.
 */
export interface DraftPrdOptions {
  /** Provider block name (key into `cfg.providers`). Explicit, never inferred. */
  provider: string;
  /** Model id for this call (e.g. `claude-haiku`, `gpt-4o-mini`). */
  model: string;
  /** Optional abort signal to bound the call (single shot, no streaming). */
  signal?: AbortSignal;
}

/**
 * The canonical offline PRD section template (mirrors the `noir-prd` skill).
 * Callers substitute this when {@link draftPrd} returns `null` (no provider/key
 * configured). Every section is present with a `<fill in>` placeholder so a
 * human (or a later model-assisted pass once a provider is configured) can
 * complete it in place at `.noir/prd/<taskId>-<slug>.md`.
 */
export const PRD_FALLBACK_TEMPLATE = `# PRD

## Problem
<fill in: what's broken or missing, in user terms>

## Evidence
<fill in: proof it's real — data, tickets, user reports. Never fabricate; cite a source.>

## Audience
<fill in: for whom>

## Success Criteria
<fill in: machine-verifiable, quantified thresholds — not "fast" or "intuitive">

## Appetite / Mode
<fill in: time-box; small batch or bet>

## Proposed Direction
<fill in: product-altitude solution sketch — not the technical design>

## No-gos
<fill in: explicitly out of scope — the highest-signal section>

## Rabbit holes
<fill in: known pitfalls to avoid>

## Open Questions
<fill in: unresolved items that need human input>
`;

// The 9 PRD sections in canonical order (mirrors PRD_FALLBACK_TEMPLATE). Used
// both to build the prompt and to keep the template + prompt in sync (a single
// edit point if the section list ever changes).
const PRD_SECTIONS = [
  'Problem',
  'Evidence',
  'Audience',
  'Success Criteria',
  'Appetite / Mode',
  'Proposed Direction',
  'No-gos',
  'Rabbit holes',
  'Open Questions',
] as const;

/**
 * Build the user prompt for the bounded draft call. Kept pure (no I/O) so the
 * prompt is testable independently of `complete()`; the caller threads
 * `input.intake/clarify/memory` straight through. The system prompt instructs
 * the model to stay product-altitude, never fabricate Evidence, and emit the 9
 * sections in order so the result parses cleanly into the artifact shape.
 */
function buildPrdPrompt(input: DraftPrdInput): string {
  const lines: string[] = [];
  lines.push('# Intake');
  lines.push(input.intake.trim() || '<no intake notes provided>');

  if (input.clarify && input.clarify.length > 0) {
    lines.push('');
    lines.push('# Clarification Q&A (resolved)');
    for (const q of input.clarify) {
      const trimmed = q.trim();
      if (trimmed) lines.push(`- ${trimmed}`);
    }
  }

  if (input.memory && input.memory.trim().length > 0) {
    lines.push('');
    lines.push('# Retrieved memory (grounding context — do not fabricate beyond this)');
    lines.push(input.memory.trim());
  }

  lines.push('');
  lines.push('# Required output');
  lines.push(
    `Draft a Product Requirements Document with EXACTLY these sections in order, each a level-2 markdown heading, no filler: ${PRD_SECTIONS.join(', ')}.`,
  );
  lines.push(
    'Stay at product altitude (the spec later handles the technical design). For Evidence, cite the intake/memory verbatim or write "<fill in: needs source>" — NEVER fabricate a metric or ticket. Success Criteria must be machine-verifiable (a check an implementer can run), not adjectives.',
  );
  return lines.join('\n');
}

const PRD_SYSTEM_PROMPT =
  'You are drafting a Noir Product Requirements Document (PRD): the pre-SDD ' +
  'product artifact the technical spec later @imports. Output ONLY the markdown ' +
  'PRD — no preamble, no closing remarks. The user message carries the intake, ' +
  'clarification Q&A, and grounding memory; never fabricate Evidence beyond what ' +
  'they provide.';

/**
 * Draft a PRD via one bounded {@link complete} call.
 *
 * Returns:
 *  - the drafted PRD text on success (`{ ok: true }` from `complete()`);
 *  - `null` when no provider/key is configured OR an attempted call failed —
 *    callers substitute {@link PRD_FALLBACK_TEMPLATE} in both cases (the offline
 *    path is first-class; blueprint D5).
 *
 * Never throws — `complete()`'s adapter try/catch surfaces failures as
 * `{ ok: false, reason }`, which this helper collapses to `null` (a missed
 * draft is recoverable: the template lands and a later pass refines it). The
 * PRD itself is the caller's responsibility to write via `writePrd` — this
 * helper ONLY produces the body text.
 *
 * @example
 * ```ts
 * const body = await draftPrd(
 *   { provider: 'anthropic', model: 'claude-haiku' },
 *   { intake, clarify, memory },
 *   resolveModelConfig(cfg.model),
 * );
 * writePrd(root, taskId, slug, body ?? PRD_FALLBACK_TEMPLATE);
 * ```
 */
export async function draftPrd(
  opts: DraftPrdOptions,
  input: DraftPrdInput,
  cfg: ModelConfig = {},
): Promise<string | null> {
  const req: CompleteRequest = {
    provider: opts.provider,
    model: opts.model,
    system: PRD_SYSTEM_PROMPT,
    prompt: buildPrdPrompt(input),
    tier: 'draft',
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const result = await complete(req, cfg);
  // null (offline) and `{ ok: false }` (attempted-call failure) both degrade to
  // null — the caller substitutes PRD_FALLBACK_TEMPLATE. Optional chain: when
  // `result` is null, `result?.ok` short-circuits to undefined → `!undefined`
  // is true, so the offline case is covered without a separate null check.
  if (!result?.ok) return null;
  return result.text;
}

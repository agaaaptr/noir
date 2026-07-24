// Structured output — prompt-based JSON + validate + at most ONE repair retry
// (slice S8 / t4, blueprint D5 / DS-4).
//
// This module is the ONLY retry site in the model layer (DS-12: SDK retries are
// 0; bounded wall-clock + cost). It does NOT call a provider directly — it is
// given a resolved {@link ProviderAdapter} by `complete()` and orchestrates the
// JSON round-trip on top of the adapter's single-shot `complete()`. Because the
// adapter surface has no `tools` / `stream` (FR-8), this path cannot mutate into
// an agent loop either: it makes at most TWO adapter calls (initial + one
// repair), parses + validates each, and returns.
//
// Strategy (DS-4 / FR-3, v1 — provider-native strict modes deferred):
//   1. Inject a "respond with ONLY JSON matching the schema" system addendum.
//   2. Call the adapter once (single shot).
//   3. Extract JSON from the text (tolerant: direct, markdown-fence, span).
//   4. Validate against `req.schema` — a ZodType (`.parse`) or a function.
//   5. On parse/validate failure, retry ONCE with the error fed back.
//   6. Still bad ⇒ `{ ok: false, reason: "schema-validation-failed: …" }`.
//
// NO zod is imported at runtime here (NFR-2 / the types.ts contract): validation
// calls `.parse` ON the caller-supplied schema object, so the built library has
// no value-level zod dependency. A best-effort `.description` (if the ZodType
// carries one) is the only schema introspection — we never serialize the shape,
// so the caller's prompt is expected to describe the desired JSON; `schema` is
// the validator, not the spec.

import type { CompleteRequest, CompleteResult, CompleteSchema, ProviderAdapter } from './types.js';

// --- Prompt construction ----------------------------------------------------

// The JSON contract appended to the system prompt. Strong + specific so the
// model emits parseable JSON without relying on a provider-native JSON mode
// (deferred per DS-4). "single valid JSON value" (not "object") so an array or
// scalar schema is also honored.
const JSON_INSTRUCTION =
  'Respond with ONLY a single valid JSON value that matches the requested schema. ' +
  'Do not include markdown, code fences, commentary, or any surrounding prose — ' +
  'output the JSON and nothing else.';

/**
 * Best-effort schema hint for the prompt. A ZodType MAY carry a `.description`
 * (set via `z.desc(...)` / `.meta({ description })`); a validator function
 * carries none. We never import zod at runtime, so we do NOT serialize the full
 * shape — the caller's prompt describes the desired JSON; `schema` validates.
 * Returns the trimmed description, or `''` when none is available.
 */
function schemaDescription(schema: CompleteSchema | undefined): string {
  if (!schema) return '';
  const desc = (schema as { description?: unknown }).description;
  return typeof desc === 'string' && desc.trim().length > 0 ? desc.trim() : '';
}

/** Append the JSON instruction (and any schema description) to the system prompt. */
function withJsonInstruction(req: CompleteRequest): CompleteRequest {
  const hint = schemaDescription(req.schema);
  const addendum = hint ? `${JSON_INSTRUCTION}\n\nJSON must satisfy: ${hint}` : JSON_INSTRUCTION;
  const system = req.system ? `${req.system}\n\n${addendum}` : addendum;
  return { ...req, system };
}

/** Bound a snippet so a runaway model output cannot blow up the corrective prompt. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Build the ONE repair retry: re-state the JSON contract, then surface the
 * precise parse/validate error and the offending output so the model can fix it.
 * The original task (`prompt`) is preserved verbatim — only the system gains the
 * correction, so the retry is still a bounded single shot at the SAME task.
 */
function withCorrectiveInstruction(
  req: CompleteRequest,
  error: string,
  badOutput: string,
): CompleteRequest {
  const base = withJsonInstruction(req);
  const correction =
    `Your previous response failed validation and was NOT valid JSON matching the schema.\n\n` +
    `Error: ${error}\n\n` +
    `Previous output (do NOT repeat it):\n${truncate(badOutput, 500)}\n\n` +
    `Return ONLY valid JSON matching the schema — no markdown, no prose.`;
  const system = base.system ? `${base.system}\n\n${correction}` : correction;
  return { ...base, system };
}

// --- JSON extraction (tolerant) ---------------------------------------------

type ParseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** `JSON.parse` with a typed outcome (never throws). */
function tryJSON(s: string): ParseOutcome {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Extract a JSON value from a model's free-form text. Tries, in order:
 *   1. the trimmed text directly (the model obeyed),
 *   2. the inside of a ```json …``` markdown fence (a common deviation),
 *   3. the outermost `{ … }` or `[ … ]` span (prose around the JSON).
 *
 * Returns the first parse success, else the parse error from the last attempt.
 * This tolerance keeps the ≤1 retry budget for genuine validation failures
 * rather than spending it on a stray code fence.
 */
function extractJSON(text: string): ParseOutcome {
  const trimmed = text.trim();

  // 1. Direct.
  const direct = tryJSON(trimmed);
  if (direct.ok) return direct;

  // 2. Markdown code fence (optional `json`/`JSON` lang tag). Capture the group
  //    into a const so the truthy guard narrows it (a re-indexed `fence[1]` would
  //    read as `string | undefined` under noUncheckedIndexedAccess).
  const fenced = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)?.[1];
  if (fenced) {
    const inner = tryJSON(fenced.trim());
    if (inner.ok) return inner;
  }

  // 3. Outermost object/array span — collect valid candidates, shortest first
  //    (a tighter valid span beats a looser one that happens to balance).
  const candidates: string[] = [];
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (objStart !== -1 && objEnd > objStart) candidates.push(trimmed.slice(objStart, objEnd + 1));
  if (arrStart !== -1 && arrEnd > arrStart) candidates.push(trimmed.slice(arrStart, arrEnd + 1));
  candidates.sort((a, b) => a.length - b.length);
  for (const cand of candidates) {
    const parsed = tryJSON(cand);
    if (parsed.ok) return parsed;
  }

  // No extraction worked — surface a short, safe excerpt (never the whole prompt
  // body, which could be large; NFR-4 keeps usage/logs free of raw content).
  const excerpt = truncate(trimmed.replace(/\s+/g, ' '), 120);
  return { ok: false, error: `response was not valid JSON: ${JSON.stringify(excerpt)}` };
}

// --- Schema validation ------------------------------------------------------

/**
 * Validate `raw` against a caller-supplied schema WITHOUT importing zod. A
 * ZodType exposes `.parse(input)` (throws on invalid); a function schema IS the
 * validator (throw on invalid). A throw ⇒ invalid; a returned value ⇒ the
 * coerced/validated value to hand back to the caller.
 *
 * `typeof === 'function'` cleanly splits the union: a `ZodType` instance is an
 * object (it has `.parse`, no call signature), so the function branch is the
 * validator-function member and the fall-through is the ZodType member. The
 * ZodType `.parse` is invoked via method syntax (`schema.parse(raw)`) so its
 * internal `this` binding is preserved — extracting `const p = schema.parse;
 * p(raw)` would lose `this` and break zod's internal state reads.
 */
function validateSchema(schema: CompleteSchema, raw: unknown): unknown {
  if (typeof schema === 'function') {
    return schema(raw);
  }
  return schema.parse(raw);
}

/** Extract + validate in one step; never throws. */
function parseAndValidate(text: string, schema: CompleteSchema): ParseOutcome {
  const extracted = extractJSON(text);
  if (!extracted.ok) return extracted;
  try {
    return { ok: true, value: validateSchema(schema, extracted.value) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `schema validation failed: ${msg}` };
  }
}

// --- The structured round-trip ----------------------------------------------

/**
 * Run the structured (prompt-JSON) flow against a resolved adapter.
 *
 * Makes at most TWO adapter calls: an initial attempt, plus ONE repair retry on
 * parse/validate failure (DS-4). An adapter/transport failure (`{ ok: false }`
 * or `null`) is propagated immediately — the retry budget is for JSON repair,
 * NOT for transient network errors (those stay bounded at one call, DS-12).
 *
 * On success the validated object is returned as `value` (FR-1), with `text`
 * kept as the raw model output of the successful call and `usage` from that
 * call. `req.schema` is required; `complete()` only routes here when it is set.
 */
export async function runStructured(
  adapter: ProviderAdapter,
  req: CompleteRequest,
  key: string | undefined,
): Promise<CompleteResult> {
  // `complete()` only calls here when `schema` is present; guard once so a
  // direct caller cannot trip on a missing schema mid-flow.
  const schema = req.schema;
  if (!schema) {
    return adapter.complete(req, key);
  }

  // --- Attempt 1: the initial JSON request. ---
  const first = await adapter.complete(withJsonInstruction(req), key);
  // Adapter/transport failure (incl. null degradation) — propagate, do NOT spend
  // the retry budget on a non-JSON failure (DS-12: transport stays single-shot).
  if (!first?.ok) return first;

  const parsed1 = parseAndValidate(first.text, schema);
  if (parsed1.ok) {
    return {
      ok: true,
      text: first.text,
      value: parsed1.value,
      ...(first.usage ? { usage: first.usage } : {}),
    };
  }

  // --- Attempt 2: the single repair retry, error fed back. ---
  const second = await adapter.complete(
    withCorrectiveInstruction(req, parsed1.error, first.text),
    key,
  );
  // If the retry's transport itself failed, the overall result is still a
  // schema-validation failure (the first output was invalid JSON and we could
  // not repair it) — surface that, not the transport error, so the caller sees
  // the real cause. The first attempt's parse error is the actionable detail.
  if (!second?.ok) {
    return { ok: false, reason: `schema-validation-failed: ${parsed1.error}` };
  }

  const parsed2 = parseAndValidate(second.text, schema);
  if (parsed2.ok) {
    return {
      ok: true,
      text: second.text,
      value: parsed2.value,
      ...(second.usage ? { usage: second.usage } : {}),
    };
  }

  // Two strikes: the model could not produce schema-valid JSON. Degrade to a
  // structured failure (NOT null — a call was attempted and billed; the caller
  // may surface this). Reason is fixed-suffix `schema-validation-failed` so
  // callers can branch on it, followed by the last parse/validate error.
  return { ok: false, reason: `schema-validation-failed: ${parsed2.error}` };
}

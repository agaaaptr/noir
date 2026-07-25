// Anthropic provider adapter — single-shot Messages call via `@anthropic-ai/sdk`
// (slice S8 / t2, blueprint D5).
//
// HARD RULES enforced here, by construction:
//
// - SINGLE-SHOT (D5 / FR-8): the request to `messages.create` carries ONLY
//   `model`, `max_tokens`, `messages`, and (optionally) `system`. There is no
//   `tools`, `tool_choice`, or `stream` key — so this adapter cannot express an
//   agent/tool loop even if a caller tried. One bounded call, then return.
// - SDK retries DISABLED (`maxRetries: 0`, DS-12 / NFR-3): the hosted SDK
//   defaults to retrying transient failures; we opt out so one call can never
//   silently multi-charge. The only retry lives in the structured path (t4).
// - IMPORT-ISOLATED (NFR-2): the `@anthropic-ai/sdk` is imported DYNAMICALLY
//   inside `complete()`. A bundle whose configured provider never resolves to
//   this adapter pays zero SDK bytes — the SDK is only pulled in at call time.
// - SECRETS stay in env (DS-8): `key` is the resolved VALUE that `complete()`
//   read from `process.env[apiKeyEnv]`; this module never touches `process.env`
//   and never logs the value. Only token COUNTS leave via `usage`.
// - NO SILENT PAID CALLS (DS-6): if `key` is absent this adapter does NOT let
//   the SDK fall back to `ANTHROPIC_API_KEY` in env — that would be a silent
//   paid call. It returns `{ ok: false }` instead. (`complete()` normally
//   degrades to `null` for a keyed provider whose env var is missing, so an
//   absent key here means the provider block was wired without `apiKeyEnv` — a
//   recoverable misconfiguration, surfaced rather than silently charged.)
//
// Errors (network, non-2xx, empty body, SDK throw) become `{ ok: false, reason }`
// — a structured failure a caller may surface. `null` degradation (no provider /
// missing key) is decided one layer up in `complete()`, BEFORE this runs.
//
// Structured output is the CALLER's concern: if `req.schema` is present, the
// t4 structured path instructs the model to emit JSON, parses the returned
// `text`, and validates it. This adapter ignores `schema` and returns raw text,
// so it stays a single, provider-agnostic completion primitive.

import { registerProviderAdapter } from '../complete.js';
import type { CompleteResult, CompleteUsage, ProviderAdapter } from '../types.js';

// Structural aliases for the dynamically-imported SDK, so this file does NOT
// depend on the SDK's exact exported types at compile time (resilient to minor
// version churn) AND does not pull the SDK into the module's top-level import
// graph (NFR-2 import isolation). The shape is exactly what we use: a
// constructor taking `{ apiKey?, maxRetries }` and a `messages.create(...)`
// returning the Anthropic Message shape. `content` is modeled loosely (an array
// of `{ type, text? }`) because we only consume the text block; narrowing is
// done by a `typeof text === 'string'` guard rather than a discriminated union,
// since the structural aliases intentionally do not enumerate every block type.
interface AnthropicMessage {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicMessages {
  create(
    params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user'; content: string }>;
    },
    options?: { signal?: AbortSignal; maxRetries?: number },
  ): Promise<AnthropicMessage>;
}

interface AnthropicClient {
  messages: AnthropicMessages;
}

type AnthropicSDK = new (opts: { apiKey?: string; maxRetries: number }) => AnthropicClient;

// Anthropic's Messages API REQUIRES `max_tokens` (unlike OpenAI, where it is
// optional). Per-tier caps (FR-10: draft 2048 / title 64 / summarize 512 /
// consolidate 2048) are the caller's job, resolved before this adapter runs;
// this is the adapter's last-resort bound so the required field is always set.
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Anthropic provider adapter. Registered under the name `anthropic` and
 * dispatched by `complete()` when a configured provider block's name is
 * `anthropic` (the hosted Messages endpoint). Returns raw text only — the
 * structured-output path (t4) wraps this adapter when a `schema` is present.
 */
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  complete: async (req, key): Promise<CompleteResult> => {
    // DS-6 defense: Anthropic is a hosted, keyed provider. If `key` is absent
    // the provider block was wired without `apiKeyEnv`; do NOT let the SDK fall
    // back to `ANTHROPIC_API_KEY` in env (silent paid call). complete() returns
    // null for a keyed provider whose env var is missing, so reaching here
    // without a key is a wiring fault — surface it, never charge silently.
    if (!key) {
      return { ok: false, reason: 'anthropic: missing API key (provider block has no apiKeyEnv)' };
    }

    try {
      // Dynamic import — a bundle that never selects the `anthropic` adapter
      // ships no `@anthropic-ai/sdk` dependency (NFR-2). `default` is the
      // `Anthropic` client class. Cast through `unknown` into a structural view
      // so this file never depends on the SDK's exact exported types (resilient
      // to minor version churn).
      const sdk = (await import('@anthropic-ai/sdk')) as unknown as { default: AnthropicSDK };
      const client = new sdk.default({
        apiKey: key, // the env VALUE resolved by complete() (DS-8).
        maxRetries: 0, // DS-12: never silently retry (bounded cost).
      });

      // Single bounded Messages call. The body carries ONLY bounded fields — no
      // `tools`, no `stream` (FR-8). `system` is a top-level Anthropic param
      // (not folded into messages, as OpenAI does); `max_tokens` is REQUIRED by
      // the Messages API, so a default is applied when the request omits it.
      const res = await client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.system !== undefined ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.prompt }],
        },
        {
          maxRetries: 0, // belt-and-suspenders: per-request as well as constructor.
          // Honor an abort signal so a caller can bound wall-clock further.
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );

      // Content is an array of blocks; with no `tools` configured the first
      // (and usually only) block is a text block. noUncheckedIndexedAccess ⇒
      // guard both presence and the text field's type before returning it.
      const block = res.content[0];
      const text = block?.text;
      if (typeof text !== 'string') {
        return {
          ok: false,
          reason: `anthropic: response had no text block (stop_reason: ${res.stop_reason ?? 'unknown'})`,
        };
      }

      const usage: CompleteUsage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };

      return { ok: true, text, usage };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `anthropic: ${reason}` };
    }
  },
};

// Self-register on import: a consumer that imports `@noir-ai/model` (whose
// index side-effect-imports this module) gets the adapter wired automatically;
// `complete()` then dispatches by provider name `anthropic`. The SDK itself is
// NOT loaded by this registration — only inside `complete()` above (NFR-2).
registerProviderAdapter('anthropic', anthropicAdapter);

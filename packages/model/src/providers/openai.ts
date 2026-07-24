// OpenAI provider adapter — single-shot chat completions via the `openai` SDK
// (slice S8 / t3, blueprint D5).
//
// HARD RULES enforced here, by construction:
//
// - SINGLE-SHOT (D5 / FR-8): the request to `chat.completions.create` carries
//   ONLY `model`, `messages`, and (optionally) `max_tokens`. There is no
//   `tools`, `functions`, or `stream` key — so this adapter cannot express an
//   agent/tool loop even if a caller tried. Single bounded call, then return.
// - SDK retries DISABLED (`maxRetries: 0`, DS-12 / NFR-3): the hosted SDK
//   defaults to retrying transient failures; we opt out so one call can never
//   silently multi-charge. The only retry lives in the structured path (t4).
// - IMPORT-ISOLATED (NFR-2): the `openai` SDK is imported DYNAMICICALLY inside
//   `complete()`. A bundle whose configured provider never resolves to this
//   adapter pays zero `openai` bytes — the SDK is only pulled in at call time.
// - SECRETS stay in env (DS-8): `key` is the resolved VALUE that `complete()`
//   read from `process.env[apiKeyEnv]`; this module never touches `process.env`
//   and never logs the value. Only token COUNTS leave via `usage`.
//
// Errors (network, non-2xx, empty body, SDK throw) become `{ ok: false, reason }`
// — a structured failure a caller may surface. `null` degradation (no provider /
// missing key) is decided one layer up in `complete()`, BEFORE this runs.

import { registerProviderAdapter } from '../complete.js';
import type { CompleteRequest, CompleteResult, ProviderAdapter } from '../types.js';

// Structural aliases for the dynamically-imported SDK, so this file does NOT
// depend on the SDK's exact exported types at compile time (resilient to minor
// version churn) AND does not pull the SDK into the module's top-level import
// graph (NFR-2 import isolation). The shape is exactly what we use: a
// constructor taking `{ apiKey?, baseURL?, maxRetries }` and a
// `chat.completions.create(...)` returning the OpenAI ChatCompletion shape.
type OpenAIChatCompletionsCreate = (
  params: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_tokens?: number;
  },
  // Second options argument mirrors the real SDK's `(params, options?)` shape,
  // so this adapter can forward the caller's wall-clock bound (NFR-3) and
  // re-assert no retries (DS-12) at the per-request level — same pattern the
  // anthropic adapter uses for `messages.create`.
  options?: { signal?: AbortSignal; maxRetries?: number },
) => Promise<{
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}>;

interface OpenAIClient {
  chat: { completions: { create: OpenAIChatCompletionsCreate } };
}

type OpenAISDK = new (opts: {
  apiKey?: string;
  baseURL?: string;
  maxRetries: number;
}) => OpenAIClient;

/** Build the OpenAI-shaped `messages` array: optional system, then the user turn. */
function buildMessages(req: CompleteRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  return messages;
}

/**
 * OpenAI provider adapter. Registered under the name `openai` and dispatched by
 * `complete()` when a configured provider block's name is `openai` (the hosted
 * endpoint). The `openai-compatible` adapter covers OpenAI-shaped LOCAL
 * endpoints (Ollama / LM Studio / vLLM) via raw `fetch` + `baseURL`.
 */
export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  complete: async (req, key): Promise<CompleteResult> => {
    // Hosted OpenAI ALWAYS requires a key. Guard explicitly so a misconfigured
    // anonymous `openai` block (no `apiKeyEnv`) cannot fall through to the SDK's
    // OWN env fallback (`OPENAI_API_KEY`) — that would be a silent paid call via
    // env presence, which DS-6 forbids. Anonymous LOCAL endpoints belong to the
    // dedicated `openai-compatible` adapter, not this one.
    if (!key) {
      return { ok: false, reason: 'openai: missing API key (set apiKeyEnv on the provider block)' };
    }
    try {
      // Dynamic import — a bundle that never selects the `openai` adapter ships
      // no `openai` dependency (NFR-2). `default` is the `OpenAI` client class.
      // Cast through `unknown` into a structural view so this file never depends
      // on the SDK's exact exported types (resilient to minor version churn).
      const sdk = (await import('openai')) as unknown as { default: OpenAISDK };
      const client = new sdk.default({
        apiKey: key, // the VALUE complete() resolved from process.env[apiKeyEnv]
        // Honor a forwarded baseURL if present (lets this adapter target a
        // custom OpenAI-shaped endpoint; the common local case uses the
        // dedicated `openai-compatible` adapter instead).
        ...(req.baseURL ? { baseURL: req.baseURL } : {}),
        maxRetries: 0, // DS-12: never silently retry (bounded cost).
      });

      const res = await client.chat.completions.create(
        {
          model: req.model,
          messages: buildMessages(req),
          // FR-8: ONLY bounded fields. No `tools` / `stream` — by construction.
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        },
        {
          maxRetries: 0, // belt-and-suspenders: per-request as well as constructor.
          // Forward the caller's wall-clock bound (NFR-3) — same conditional
          // spread as the other optional fields (only when a signal is present).
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );

      const text = res.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        return { ok: false, reason: 'openai: completion had no message content' };
      }

      const usage = res.usage;
      return {
        ok: true,
        text,
        ...(usage
          ? {
              usage: {
                ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
                ...(usage.completion_tokens !== undefined
                  ? { outputTokens: usage.completion_tokens }
                  : {}),
              },
            }
          : {}),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `openai: ${reason}` };
    }
  },
};

// Self-register on import: a consumer that imports `@noir-ai/model` (whose
// index side-effect-imports this module) gets the adapter wired automatically;
// `complete()` then dispatches by provider name `openai`. The SDK itself is NOT
// loaded by this registration — only inside `complete()` above (NFR-2).
registerProviderAdapter('openai', openaiAdapter);

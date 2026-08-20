// OpenAI-COMPATIBLE provider adapter — single-shot chat completions over the
// GLOBAL `fetch` (slice S8 / t3, blueprint D5). Zero non-fetch dependencies.
//
// This is the local / self-host escape hatch: any endpoint that speaks the
// OpenAI Chat Completions JSON shape is reached here via its `baseURL` — Ollama
// (`http://localhost:11434/v1`), LM Studio, vLLM, llama.cpp server, … — without
// a per-vendor adapter and without a single SDK dependency.
//
// HARD RULES enforced here, by construction:
//
// - SINGLE-SHOT (D5 / FR-8): the POST body carries ONLY `model`, `messages`,
//   and (optionally) `max_tokens`. No `tools` / `functions` / `stream` — this
//   adapter cannot express an agent/tool loop. One request, parse, return.
// - NO SDK, NO RETRY MACHINERY (NFR-2/3): raw `fetch` is a single shot;
//   the only retry lives in the structured path (t4). Uses the GLOBAL `fetch`
//   (Node ≥20, per `engines.node ">=20"`) — zero added dependency.
// - SECRETS stay in env: `key` is the VALUE resolved by `complete()`; an
//   ANONYMOUS local provider (Ollama with no `apiKeyEnv`) reaches here with
//   `key === undefined` and we simply omit the `Authorization` header. This
//   module never reads `process.env` and never logs the value.
//
// Errors (network failure, non-2xx, empty body, fetch throw) become
// `{ ok: false, reason }`. `null` degradation (no provider / missing key) is
// decided one layer up in `complete()`, BEFORE this runs.

import { registerProviderAdapter } from '../complete.js';
import type { CompleteRequest, CompleteResult, ProviderAdapter } from '../types.js';

/** Default wall-clock bound on the completion POST when the caller passes no
 *  signal (the common path — `complete()`/consolidation/draft inject none). A
 *  local compatible endpoint that accepts TCP but never answers (model loading,
 *  hung gateway) must not hang the daemon MCP handler indefinitely; 120s is
 *  generous for a single-shot completion. */
const OPENAI_COMPATIBLE_FETCH_TIMEOUT_MS = 120_000;

// The OpenAI Chat Completions response shape — only the fields we read. The
// `content` may be `null` (e.g. a tool-call frame, which we never request, or a
// content-filtered refusal); we treat non-string content as a structured miss.
interface OpenAICompatibleResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Build the OpenAI-shaped `messages` array: optional system, then the user turn. */
function buildMessages(req: CompleteRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  return messages;
}

/** Join a `baseURL` and `/chat/completions`, tolerating trailing slashes. */
function joinEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * OpenAI-compatible provider adapter. Registered under the name
 * `openai-compatible` and dispatched by `complete()`. `baseURL` (forwarded onto
 * {@link CompleteRequest} from the provider block by `complete()`) selects the
 * endpoint; the request/response are the OpenAI Chat Completions JSON shape, so
 * any compatible server works with no vendor-specific code.
 */
export const openaiCompatibleAdapter: ProviderAdapter = {
  name: 'openai-compatible',
  complete: async (req, key): Promise<CompleteResult> => {
    // baseURL is the ONE piece of provider-block config this adapter needs; it
    // is forwarded from `cfg.providers[name].baseURL` by complete() (the only
    // adapter that consumes it). Missing ⇒ misconfiguration, not degradation.
    const baseURL = req.baseURL;
    if (!baseURL) {
      return { ok: false, reason: 'openai-compatible: provider block has no baseURL' };
    }
    const endpoint = joinEndpoint(baseURL);

    // FR-8: ONLY bounded fields. No `tools` / `stream` — by construction.
    const body: Record<string, unknown> = {
      model: req.model,
      messages: buildMessages(req),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Anonymous local provider (Ollama without `apiKeyEnv`): key is undefined ⇒
    // NO Authorization header is sent. A keyed compatible endpoint gets Bearer.
    if (key) headers.authorization = `Bearer ${key}`;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // Pass-through abort so a caller can bound wall-clock (single shot; no
        // stream to cancel). Default a bound when the caller passes none — this
        // is the only raw-fetch provider path and must not hang indefinitely.
        signal: req.signal ?? AbortSignal.timeout(OPENAI_COMPATIBLE_FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        // NFR-4: surface ONLY the HTTP status — NEVER embed the raw response
        // body in `reason`. A malicious or echoing endpoint (Ollama / LM
        // Studio / vLLM / any gateway) could echo the request body (the
        // prompt) or reflect headers (the `Bearer` / `sk-` key) into its
        // error frame, and callers surface `reason` directly. Reading the
        // body here would only invite a leak, so the body is not read at all.
        return { ok: false, reason: `openai-compatible: HTTP ${res.status}` };
      }

      const json = (await res.json()) as OpenAICompatibleResponse;
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        return { ok: false, reason: 'openai-compatible: completion had no message content' };
      }

      const usage = json.usage;
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
      // Abort is an expected caller-initiated bound, not a paid failure.
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, reason: 'openai-compatible: request aborted' };
      }
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `openai-compatible: ${reason}` };
    }
  },
};

// Self-register on import: a consumer that imports `@noir-ai/model` (whose
// index side-effect-imports this module) gets the adapter wired automatically;
// `complete()` dispatches by provider name `openai-compatible`. (Routing a
// free-form provider key like `ollama` to this adapter is the t4 dispatch job.)
registerProviderAdapter('openai-compatible', openaiCompatibleAdapter);

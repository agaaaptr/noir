# ADR-0012: Provider transport fields + ambient-env neutralization

- **Status:** proposed
- **Date:** 2026-09-14
- **Scope:** `@noir-ai/model`, `@noir-ai/core` (config schema), `@noir-ai/cli` (`noir env`)
- **Spec:** `docs/internal/specs/2026-09-14-env-templates-upgrade-provider-run-ux-design.md` §6

## Context

Noir's model layer promises provider-explicit, no-silent-paid-call behavior: the provider is
resolved only from explicit config, never from env-var presence. Two verified defects break
that promise in opposite directions:

1. **A decoy field.** `model.providers.anthropic.baseURL` is accepted by the config schema
   and forwarded onto the request, but the anthropic adapter constructs its SDK client with
   only `{apiKey, maxRetries}` and silently drops `baseURL`
   (`packages/model/src/providers/anthropic.ts`). The request goes to the wrong host. Only
   the `openai-compatible` adapter honors `baseURL`.
2. **An accidental path.** Because the client is built without `baseURL`/`authToken`, the
   `@anthropic-ai/sdk` constructor falls back to reading `ANTHROPIC_BASE_URL` and
   `ANTHROPIC_AUTH_TOKEN` from `process.env` on its own. A corporate-gateway setup therefore
   works — invisibly, unverifiably, and in direct contradiction of the adapter's own stated
   invariant that env-var presence is never consulted. The no-silent-paid-call guard blocks
   only the `apiKey` env fallback, leaving baseURL/authToken fallbacks live.

Meanwhile the ecosystem has converged on a recurring configuration shape for
Anthropic-shaped gateways (Z.AI, LiteLLM, OpenRouter, Kimi, LM Studio): a host-only base URL
plus a bearer credential plus optional model remaps and timeouts. Noir has no first-class way
to express any of it.

## Decision

1. **Extend the provider block** (`model.providers.<name>`) with two transport fields:
   - `authTokenEnv?: string` — a variable NAME (same indirection rule as `apiKeyEnv`);
     its value is sent as `Authorization: Bearer` by the anthropic adapter.
   - `timeoutMs?: number` — per-request timeout in milliseconds (SDK `timeout` option),
     minimum 1000.
   - `baseURL` semantics are corrected: honored by BOTH the anthropic and
     openai-compatible adapters (no longer a decoy for anthropic).
2. **Neutralize ambient env in the model layer.** The anthropic adapter constructs the SDK
   client with explicit values for every transport-affecting option (`baseURL`, `authToken`,
   `apiKey`, `timeout`), so the SDK's constructor-time env fallbacks
   (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`) can never route a
   request the provider-explicit path did not choose. When neither credential resolves, the
   existing null-degradation fires before any client exists.
3. **Keep the host path untouched.** `noir run` passes `.noir/.env` through to the spawned
   host CLI by inheritance — that is the documented, intended gateway surface for hosts, and
   this ADR changes nothing about it.

## Consequences

- Provider-explicit becomes true in the letter: model-layer traffic goes only where config
  says.
- **Narrow breaking change:** users who relied on the accidental ambient path for the model
  layer (e.g. memory consolidation through a gateway) must add `baseURL`/`authTokenEnv` to
  `model.providers`. Documented in CHANGELOG; the `.noir/.env` gateway block added in this
  release makes the host path self-documenting.
- The no-silent-paid-call invariant is strengthened: ambient env can no longer produce a
  paid call the config did not ask for.
- `noir env` reports the gateway variables (names + winning source only) so the two paths
  (host passthrough vs model-layer config) are inspectable separately.

## Alternatives considered

- **Document the ambient path instead of neutralizing it** — rejected: it leaves a stated
  invariant false, makes consolidation traffic unauditable, and timeout/Bearer/headers remain
  unconfigurable.
- **A `wire: 'anthropic' | 'openai'` shape field on custom-named providers** — deferred: the
  adapter set already implies the wire format per provider name; revisit if custom provider
  names needing an anthropic wire shape become a real request.

# Noir — S8 Bounded Model Layer Design (`@noir-ai/model`)

- **Date:** 2026-07-24
- **Status:** DRAFT v0 — pending clarification answers (OQ-1…OQ-6). Do not implement until resolved.
- **Parent:** blueprint §8 D5 (bounded model) + grounding digest §10 S8 + the delivered S4 engine (deferred artifact generation).
- **Slice:** S8 — roadmap v1.0. Depends on `@noir-ai/core` (config). Consumed by S4 (full-mode artifact drafting + Document phase), S7 (memory consolidation), S9 (home help).

> **Status: RESOLVED 2026-07-25 — implemented & validated (340/340 tests). OQs resolved per docs/superpowers/plans/2026-07-24-v1.0-execution-plan.md §1.**

---

## 0. TL;DR

A **thin, single-shot model layer** — one `complete()` function backed by three adapters (`anthropic`, `openai`, `openai-compatible` for Ollama/others via `baseURL`). It closes the S4 deferred gap: real spec/plan/intake drafting and the Document phase. It is **provider-explicit by design** (never a silent paid call), **forbids tool/exec loops by design** (no `tools` param), and **degrades to `null` + templates** when no provider is configured — a first-class, fully-tested mode. It is a **library, not a tool surface**: no MCP tools are registered; it is consumed in-process by S4/S7/S9.

---

## 1. Objective + problem

**Problem.** S4 delivered the workflow engine with observable gates, but `advance()` in `full` mode does not actually *draft* artifacts — spec/plan/intake writers emit stubs, and the Document phase is unwired (digest §3: "S4 deferred: artifact generation in full-mode advance is NOT wired (needs S8 model layer)"). Today a human writes every spec/plan by hand. The same gap blocks S7 consolidation (derive `type:lesson` from observations) and S9 home help.

**Objective.** Add the smallest possible bounded model abstraction that (a) unblocks automated drafting for S4/S7/S9, (b) never violates the D5 blueprint hard rule (single-shot only, never a tool/exec loop), and (c) makes "no provider configured" a first-class, tested, non-errored path — so the full Noir test suite stays offline and free, and a user with no API key loses nothing.

**Non-goal.** This is not an agent runtime. Noir orchestrates discipline (S4 gates, S5 skills, S6 context, S7 memory); the model layer only fills bounded content slots on explicit request.

---

## 2. Decisions (drafted; OQ-1…6 for review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | Package shape | **New `@noir-ai/model` package; library only — NO MCP tools** | Mirrors S5 (one package per concern). Consumed in-process by S4/S7/S9. Registering MCP tools would make it a host surface + invite unbounded use; D5 wants bounded single-shot calls invoked by Noir, not the host. |
| DS-2 | Interface | **One function: `complete({system, prompt, schema?, provider, model, maxTokens, onUsage?}) → string \| object \| null`** | Digest §10 S8: thin internal interface. No streaming, **no `tools` param** (forbids agent loops by construction — they cannot be passed). `onUsage?` callback keeps the return type exactly as the digest specifies while still logging cost. |
| DS-3 | Adapters | **`anthropic`, `openai`, `openai-compatible`** (Ollama/others via `baseURL`, raw `fetch`) | Digest §10 S8. `openai-compatible` is the local/self-host escape hatch (Ollama, LM Studio, etc.) without a per-vendor adapter. |
| DS-4 | Structured output (v1) | **Prompt-based JSON + JSON-Schema validate + ≤1 retry; else `null`** | Digest §10 S8. Provider-native strict modes (OpenAI `strict_json`, Anthropic forced-tool) are per-adapter *later* — not needed to ship v1 and would leak abstraction early. |
| DS-5 | Degradation contract | **`null` return is first-class**: no provider ⇒ `null`; key missing ⇒ `null`; API/validation error ⇒ `null`. Call sites branch + substitute a template/stub. | D5 + digest §10 S8: "degrades to templates when no provider" and "S4 gates test for *result presence*, never AI success." Throwing would force every caller into try/catch; `null` is branchable and offline-testable. |
| DS-6 | Provider-explicit, never silent | **Provider resolved ONLY from explicit `model:` config.** Never inferred from env-var presence. No explicit provider ⇒ `null`. | D5 hard rule + digest §10 S8: "NEVER silent paid calls." Env presence ≠ consent; a user with `ANTHROPIC_API_KEY` set for another tool must not get billed by Noir silently. |
| DS-7 | Config block | **New top-level `model:` in `NoirConfigSchema`, mirroring `daemon` (Zod object + `.default({})`)**; `defaultProvider?`, `tiers` (draft/title/summarize/consolidate), `providers` record | Digest §5: extend idiomatically with a new `.default({})` property — existing `.noir/config.yml` files keep working with zero migration. |
| DS-8 | Secrets | **Env vars only** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); config stores the **env-var name** (`apiKeyEnv`), never the value. OS keychain deferred. | Digest §10 S8: "env vars for secrets … defer OS keychain." Storing names keeps config shareable/commitable; values never touch disk via Noir. |
| DS-9 | Per-task tiers + usage | **4 tiers** (draft/title/summarize → cheap; consolidate → mid); each call logs `{provider, model, tokensIn, tokensOut, tier}`; surfaced in `noir doctor`. | Digest §10 S8: "drafts/titles/summaries → cheap; consolidation → mid. Log `usage`; surface in `noir doctor`." |
| DS-10 | Build thin + native | **Reject Vercel AI SDK + LiteLLM**; implement 3 lean adapters directly | Digest §10 S8 + §9 stance: Vercel over-buys streaming/tool machinery Noir *forbids* + Zod/bundle cost; LiteLLM is Python. "Adopt the ideas as native designs, do not copy." |
| DS-11 | Prompt caching | **Defer to v1.x** (Anthropic-only, shared system-prompt block) | Digest §10 S8. Marginal gain in v1 (few calls, short sessions); adds provider-specific branching now. |
| DS-12 | Retries/backoff | **SDK internal retries = 0**; the only retry is the DS-4 JSON-repair retry (≤1) | Keeps every call bounded in wall-clock and cost; prevents silent multi-paid-retry storms. *(assumption — confirm SDK retry knobs are reachable — OQ-6)* |

---

## 3. Scope

### 3.1 In scope
- `@noir-ai/model` package: the `complete()` interface + 3 adapters + provider/tier resolution + usage logging hook.
- Prompt-based structured output (JSON + JSON-Schema validate + ≤1 retry).
- First-class `null`-degradation path (tested as a peer to the happy path).
- `model:` config block in `NoirConfigSchema` (Zod, defaulted).
- Wiring points (not the consumers themselves): S4 full-mode artifact writers call `complete()`; S7 consolidation calls `complete()`; S9 home help calls `complete()`. (S4/S7/S9 own their own integration; S8 exposes the seam.)

### 3.2 Out of scope (explicitly deferred, with rationale)
- **Streaming** — D5 forbids agent loops; streaming adds backpressure/UX machinery for ~zero v1 value (short, single-shot outputs). v1.x if a TUI wants it.
- **Tool-calling / agent loops** — forbidden *by design* (DS-2: no `tools` param). Noir orchestrates via S4 gates + S5 skills, not via model tool-loops.
- **OS keychain** (macOS Keychain / Windows Credential Manager / `secret-service`) — DS-8; env vars suffice for v1, cross-platform keychain is its own slice.
- **Prompt caching** — DS-11; Anthropic-only, deferred to v1.x.
- **Provider-native structured output** (OpenAI `response_format: strict`, Anthropic forced-tool) — DS-4; prompt-JSON is enough for v1, native modes come per-adapter later.
- **Embeddings / rerankers** — that is the S6 `EmbedFn` seam (digest §2, §10 Embeddings), not the chat model layer. Distinct concern, distinct slice.
- **An MCP tool surface** — DS-1; the model layer is a library. (A future `noir ask` one-shot tool, if ever, is an S9 CLI decision, not S8.)
- **Multi-host provider auth helpers** (e.g., Vertex AI / Bedrock wrappers) — v1.x; `openai-compatible` + `baseURL` covers the common local cases.

---

## 4. Functional requirements

- **FR-1** `complete(req)` per DS-2; returns `string` (free-text mode), `object` (when `schema?` present + parse OK), or `null` (degraded).
- **FR-2** Three adapters (`anthropic`, `openai`, `openai-compatible`) each implement: free-text completion, structured completion (prompt-JSON), auth (env-resolved key or anonymous for local), error → `null`.
- **FR-3** Structured path: inject a "respond with strict JSON matching this schema" system addendum + the schema; parse; validate against the JSON-Schema; on failure, **one** repair retry feeding the parse error back; second failure ⇒ `null`.
- **FR-4** Provider resolution: `tier → (tier.provider ?? defaultProvider) → providers[name]`. If unresolvable ⇒ `null` immediately (no network).
- **FR-5** Key resolution: read `process.env[providers[name].apiKeyEnv]`; missing ⇒ `null` + a logged miss (not a throw). Local providers with no `apiKeyEnv` are anonymous (allowed).
- **FR-6** `onUsage?({provider, model, tokensIn, tokensOut, tier})` invoked on every successful call; never on `null`. Wired to a module-level sink `noir doctor` reads.
- **FR-7** `model:` config block (DS-7) with Zod defaults; absent block ⇒ empty object (full degradation, offline).
- **FR-8** The `complete` signature **does not accept** a `tools`, `functions`, or `stream` parameter (compile-time enforcement via the TS type).
- **FR-9** Library export only — **zero MCP tool registrations**. Discovery via `@noir-ai/model` import, not via the daemon `ServerContext`.
- **FR-10** Per-tier `maxTokens` defaults applied when the request omits `maxTokens` (draft 2048, title 64, summarize 512, consolidate 2048 — illustrative, OQ-3/OQ-6).

---

## 5. Non-functional requirements

- **NFR-1** Full test suite runs **offline**: null-degradation exercised end-to-end; adapters tested against **recorded fixture responses**; **zero network in CI**.
- **NFR-2** Bundle: adapter SDK deps are **per-adapter and import-isolated** — a project using only `openai-compatible` pulls in no `@anthropic-ai/sdk`/`openai` dep. `openai-compatible` uses **global `fetch`** (Node ≥20) — zero extra dep.
- **NFR-3** Bounded wall-clock per call: single shot, no streaming, SDK retries = 0, ≤1 JSON-repair retry.
- **NFR-4** Secrets never logged: only the **env-var name** appears in config/doctor output; values are redacted; usage logs carry counts, never prompts or keys.
- **NFR-5** Cost guard: tier `maxTokens` caps output; no `tools` ⇒ no unbounded tool fan-out; usage logged for audit.
- **NFR-6** TS `strict` + `noUncheckedIndexedAccess`, Biome clean, tsup ESM+dts, matches monorepo conventions (digest §1).

---

## 6. Architecture

```
@noir-ai/model
├─ complete.ts            # public complete(req) → string|object|null; provider/key resolution; degradation
├─ structured.ts          # prompt-JSON + validate + ≤1 retry
├─ usage.ts               # onUsage sink (noir doctor reads)
├─ adapters/
│  ├─ anthropic.ts        # @anthropic-ai/sdk, messages.create, max_tokens, no tools
│  ├─ openai.ts           # openai SDK, chat.completions, no tools
│  └─ openai-compatible.ts# global fetch POST {baseURL}/chat/completions (Ollama/LM Studio/…)
├─ types.ts               # CompleteRequest, Provider, tiers, JSONSchema passthrough
└─ index.ts               # re-exports complete() + types (NO server/registration code)
```

**Call flow.** Caller (S4 writer / S7 consolidator / S9 home) builds a `CompleteRequest`, passes the resolved `tier`. `complete()`:
1. Resolves `provider` from config (FR-4). Unresolvable ⇒ return `null`.
2. Resolves key (FR-5). Missing for a keyed provider ⇒ return `null` + log miss.
3. Selects adapter; if `schema?` present, routes through `structured.ts` (FR-3), else free-text.
4. Adapter returns text/parsed-object, or `null` on any error (FR-2/FR-5).
5. On success, fires `onUsage` (FR-6).

**No MCP surface.** The daemon `ServerContext` is **not** extended with a model service (contrast S6/S7 which will extend it). `@noir-ai/model` is imported directly by the packages that need it. This keeps the model layer unreachable from the host, enforcing D5 at the boundary.

**Consumers (wiring points, owned by their slices):**
- **S4** — full-mode `advance()` spec/plan/intake writers + Document phase (CHANGELOG/decision stubs): call `complete({tier:'draft'|'summarize', …})`; on `null`, write the existing template skeleton (S4's current behavior).
- **S7** — `noir memory consolidate`: calls `complete({tier:'consolidate', schema: lessonSchema})`; on `null`, refuse consolidation + log (digest §10 S7: "refuse consolidation if no provider").
- **S9** — `noir` home menu / `status` suggestions: calls `complete({tier:'summarize', …})`; on `null`, hide the AI-suggestions section entirely.

---

## 7. Config

New top-level `model:` block in `NoirConfigSchema` (digest §5 — mirrors `daemon`: `z.object({...}).default({})`):

```ts
model: z.object({
  defaultProvider: z.enum(['anthropic', 'openai', 'openai-compatible']).optional(),
  tiers: z.object({
    draft:       tierSchema.optional(),
    title:       tierSchema.optional(),
    summarize:   tierSchema.optional(),
    consolidate: tierSchema.optional(),
  }).default({}),
  providers: z.record(
    z.string(),                                  // key = provider block name
    z.object({
      model: z.string(),
      baseURL: z.string().url().optional(),
      apiKeyEnv: z.string().optional(),          // env-var NAME, never the value
    })
  ).default({}),
}).default({})

// where tierSchema =
z.object({
  provider: z.string().optional(),               // key into providers{}
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
})
```

Illustrative `.noir/config.yml` (model IDs are illustrative — confirmed in OQ-3):

```yaml
model:
  defaultProvider: anthropic
  tiers:
    draft:       { provider: anthropic, model: claude-haiku, maxTokens: 2048 }
    title:       { provider: anthropic, model: claude-haiku, maxTokens: 64 }
    summarize:   { provider: anthropic, model: claude-haiku, maxTokens: 512 }
    consolidate: { provider: anthropic, model: claude-sonnet, maxTokens: 2048 }
  providers:
    anthropic:
      model: claude-haiku
      apiKeyEnv: ANTHROPIC_API_KEY
    openai:
      model: gpt-4o-mini
      apiKeyEnv: OPENAI_API_KEY
    ollama:                       # openai-compatible, reached when a tier sets provider: ollama
      model: llama3.1
      baseURL: http://localhost:11434/v1
      # no apiKeyEnv ⇒ anonymous (local)
```

Omitting the whole block ⇒ `model = {}` ⇒ every tier degrades to `null` (offline, free, the default).

---

## 8. Key management

- **Secrets live in env vars.** Noir reads `process.env[apiKeyEnv]` at call time; it never stores, logs, or echoes the value.
- **Config stores the env-var name only** (`apiKeyEnv: ANTHROPIC_API_KEY`), so `.noir/config.yml` is safe to commit and share.
- **No env-presence inference** (DS-6): `ANTHROPIC_API_KEY` being set does **not** make Anthropic the provider. The user must write `defaultProvider: anthropic` (or a tier override). This is the single most important guard against silent paid calls.
- **Anonymous local providers** (Ollama, LM Studio) omit `apiKeyEnv` entirely; the `openai-compatible` adapter then sends no auth header.
- **OS keychain** (Keychain/Credential Manager/`secret-service`) is deferred (DS-8) — tracked as v0 debt.

---

## 9. Degradation flow

```
complete(req)
  │
  ├─ resolve provider (tier.provider ?? defaultProvider ?? providers[name])
  │     ├─ unresolvable ──────────────────────► return null        (no network)
  │     └─ resolved ──┐
  │                  │
  ├─ resolve key: env[apiKeyEnv] (or anonymous if no apiKeyEnv)
  │     ├─ keyed provider + env missing ──────► log miss, return null
  │     └─ ok / anonymous ──┐
  │                        │
  ├─ adapter call (free-text OR structured via FR-3)
  │     ├─ network/HTTP/non-2xx ──────────────► log, return null
  │     ├─ structured: parse/validate fail twice ► return null
  │     └─ success ───────────────────────────► fire onUsage, return string|object
  │
  ▼
call site branches on null:
  • S4  → write template skeleton (current S4 behavior; gate passes on "artifact present")
  • S7  → refuse consolidation + log "no provider"
  • S9  → hide AI-suggestions section
```

S4 gates assert **result presence** (artifact was produced), **never AI success** — so the degraded path is fully green offline.

---

## 10. Dependencies

| Dep | Where | Notes |
|---|---|---|
| `@anthropic-ai/sdk` | `adapters/anthropic.ts` | Per-adapter; only imported when that adapter is selected. Bundle impact: ~moderate; isolated via dynamic import so non-Anthropic users don't pay. |
| `openai` | `adapters/openai.ts` | Per-adapter; same isolation. |
| *(none)* | `adapters/openai-compatible.ts` | Uses **global `fetch`** (Node ≥20; `engines.node ">=20"`). Zero dep — the leanest path, also the local/Ollama default. |
| `ajv` *(or `@sinclair/typebox`/native `JSON.parse`+manual)* | `structured.ts` | JSON-Schema validate. *(assumption — confirm which validator; OQ-2)* — pick the smallest correct one. |

**Bundle implications.** All three SDK paths are reachable only via dynamic `import()` inside the chosen adapter, so a tree-shaken CLI that never configures Anthropic/OpenAI ships **neither** SDK. `openai-compatible` + `fetch` is the zero-dep local default. Native implications: `fetch` is global in Node 20+ (no `node-fetch`); no native addon is added by S8 (unlike S6's `onnxruntime-node`).

---

## 11. Assumptions (FLAG)

- *(assumption — confirm)* Node ≥20 global `fetch` is the transport for `openai-compatible` (digest §1: `engines.node ">=20"` — OK).
- *(assumption — confirm)* Both provider SDKs expose a knob to **disable internal retries** (DS-12); if not, adapters wrap calls to swallow retry-driven multi-charging. (OQ-6)
- *(assumption — confirm)* Model IDs in §7 are illustrative placeholders, not committed defaults (OQ-3).
- *(assumption — confirm)* JSON-Schema validator choice is small enough not to dominate the bundle (OQ-2).
- *(assumption — confirm)* v1 call volume is low enough that prompt caching (DS-11) is not worth its provider-specific branching now.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Silent paid calls** | DS-6 (no env-inference) + DS-5 (`null` default) + FR-8 (no `tools`) + NFR-4 (key never logged). A user must write an explicit `defaultProvider` to spend money. |
| **Vendor lock-in** | DS-2 thin interface + DS-3 three adapters incl. `openai-compatible`; nothing Anthropic/OpenAI-specific leaks into `complete()`. |
| **Key leakage** | NFR-4: only env-var names in config/doctor; values redacted; prompts not logged with usage. |
| **Unbounded cost / runaway** | DS-12 (retries = 0), DS-4 (≤1 JSON retry), FR-10 (tier `maxTokens`), FR-8 (no `tools`), DS-9 (usage logged). |
| **Flaky network tests in CI** | NFR-1: fixture-only adapter tests; full suite offline; degradation path is the always-available default. |
| **Model ID drift** | Models are config strings (DS-7), not code constants; doctor reports configured model. |
| **JSON parse failures** | DS-4: validate + ≤1 repair retry, else `null` + caller template. Bounded. |

---

## 13. Alternatives (rejected)

- **Vercel AI SDK** — rejected (digest §10 S8, §9 stance). It over-buys exactly what D5 forbids: a streaming + tool-calling + agent abstraction, plus a Zod-centric API and non-trivial bundle. Noir wants none of that machinery; a 3-adapter `complete()` is smaller and constraint-preserving.
- **LiteLLM** — rejected. Python; Noir is a TS pnpm monorepo. Wrong runtime entirely.
- **LangChain / LangChain.js** — rejected. Heavy, opinionated, agent/streaming-centric; pulls a dependency graph far larger than the problem.
- **Raw `fetch` for all three adapters (no SDKs)** — considered. Loses typed errors, idiomatic auth, and header handling for Anthropic/OpenAI. Compromise: SDKs for the two hosted providers (worth the dep, dynamically imported), raw `fetch` for `openai-compatible`.
- **MCP tool surface (`model.complete` tool)** — rejected (DS-1). Would make the model layer a host-callable surface, inviting unbounded/host-driven calls — the opposite of D5's "Noir invokes bounded single-shot tasks."

---

## 14. Testing & CI

- **Unit (offline):**
  - `complete()` returns `null` when: no `model:` block; no `defaultProvider` + no tier override; keyed provider + env missing; simulated HTTP non-2xx; structured parse fails twice.
  - Provider resolution: `tier → defaultProvider → providers[name]` precedence; anonymous local provider allowed.
  - Structured path: valid JSON ⇒ object; malformed → repair retry → success; malformed twice ⇒ `null`.
  - `onUsage` fires only on success; carries tier/provider/model/token counts; never includes prompt or key.
  - Config: Zod defaults keep an absent/empty `model:` block valid (no migration).
- **Adapter tests (fixture-based, NO network):** recorded HTTP responses per adapter — happy (string), structured (object), auth-missing (null), HTTP-error (null). Fixtures committed; CI offline.
- **Integration:** S4 ArtifactWriter produces a **templated** spec when `complete` returns `null`, and an **AI-drafted** spec when the adapter is mocked — both satisfy the S4 "artifact present" gate.
- **CI:** ubuntu + macos, Node 22 (digest §1). Network calls fail the build.

---

## 15. Open questions (recommended default each; ⚡ = gating)

- **OQ-1 ⚡ — Provider set for v1.** Recommended: **all three — `anthropic` + `openai` + `openai-compatible`** (the third covers Ollama/local + any compatible endpoint via `baseURL`). Alternatives: `anthropic`-only (minimal but locks out local/OpenAI users), or `+voyage` (no — Voyage is embeddings, S6's seam, not chat). Gating because it sets the adapter surface.
- **OQ-2 ⚡ — Structured-output strategy.** Recommended: **prompt-JSON + JSON-Schema validate (ajv) + ≤1 retry** for v1; defer OpenAI `strict` / Anthropic forced-tool to per-adapter v1.x. Gating because it fixes `structured.ts` + the `schema?` contract.
- **OQ-3 — Per-task model defaults.** Recommended: cheap tier (`claude-haiku` / `gpt-4o-mini` class) for `draft`/`title`/`summarize`; mid tier (`claude-sonnet` / `gpt-4o` class) for `consolidate`. Exact IDs are config defaults (illustrative in §7), never code constants. Confirm the v1 default model strings.
- **OQ-4 — Where provider blocks live.** Recommended: **`.noir/config.yml` under `model:`** (mirrors `daemon`). Alternative: separate `.noir/model.yml` — rejected (one config file is the established idiom).
- **OQ-5 — Does `noir doctor` report provider status?** Recommended: **yes** — per configured provider: resolved model, key present/absent (bool only, never value), last-call usage, and an explicit "degraded (no provider)" line when `model:` is empty. Never makes a live call.
- **OQ-6 — SDK retry/backoff knobs + per-tier `maxTokens` defaults.** Recommended: **SDK retries = 0** (DS-12), and the illustrative `maxTokens` in FR-10 (draft 2048 / title 64 / summarize 512 / consolidate 2048). Confirm both SDKs expose the retry knob; if not, wrap to enforce.

---

## 16. Acceptance

- `@noir-ai/model` package exists, builds (`tsup` ESM + dts + sourcemap), Biome clean, TS strict.
- `complete({system, prompt, schema?, provider, model, maxTokens, onUsage?}) → string | object | null` implemented; signature rejects `tools`/`stream` at compile time.
- Three adapters (`anthropic`, `openai`, `openai-compatible`) implemented; `openai-compatible` has zero non-fetch deps.
- Null-degradation path tested as a peer to the happy path; full suite offline.
- `model:` config block added to `NoirConfigSchema` with `.default({})`; pre-existing configs unchanged.
- `noir doctor` reports provider status (per OQ-5).
- S4 full-mode artifact writers + Document phase invoke `complete()` and fall back to templates on `null` (wiring verified, even if deep consumer behavior is S4/S7/S9-owned).
- All tests green; suite count `142 + N` with zero network calls.

---

## 17. Definition of Done

- Spec reviewed — OQ-1…OQ-6 resolved (esp. ⚡ OQ-1, OQ-2).
- → **writing-plans** → subagent-driven implement + review (implementer + reviewer, sonnet) → final opus whole-branch review → 1 fix wave (digest §1 SDD dogfood).
- Merge to `develop` (commits stay local until user pushes).
- Carry-forward v0 debt recorded in backlog: prompt caching (DS-11), OS keychain (DS-8), provider-native structured output (DS-4 later), foreground-only daemon unrelated.

---

## 18. References

- Grounding: `.superpowers/sdd/2026-07-24-s6-s9-grounding-digest.md` §8 D5, §10 S8, §5 config, §9 stance, §3 S4-deferred.
- Parent blueprint: §8 D5 (bounded model), §9.1 (observable + escapable gates).
- Sibling spec: `docs/superpowers/specs/2026-07-24-s5-skills-design.md` (structure + DS/OQ format).
- External: [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript), [OpenAI SDK](https://github.com/openai/openai-node), [Ollama OpenAI compat](https://ollama.com/blog/openai-compatibility), [JSON Schema](https://json-schema.org/).

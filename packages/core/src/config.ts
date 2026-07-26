import * as z from 'zod';

export const NoirConfigSchema = z.object({
  // S10 multi-host: widens from `z.literal('claude')` to a 5-value enum. The
  // canonical `HostId` union lives in @noir-ai/adapters (single owner); core
  // owns the enum STRING here so it does not import adapters (no core→adapters
  // cycle — mirrors the existing pattern where `model`/`memory`/`context`/`prd`
  // redeclare shapes their resolvers consume). `claude` remains the default so
  // existing single-host projects are byte-equivalent (regression anchor).
  host: z.enum(['claude', 'agents-md', 'gemini', 'cursor', 'opencode']).default('claude'),
  name: z.string().optional(),
  mode: z.enum(['full', 'quick']).default('full'),
  daemon: z
    .object({
      idleTimeoutSec: z.number().int().positive().default(900),
      port: z.number().int().min(0).max(65535).optional(),
    })
    .default({ idleTimeoutSec: 900 }),
  // Slice S6 context layer (@noir-ai/context). Mirrors the `daemon` idiom — a
  // top-level object with `.default({})` so a config with NO `context:` block
  // still parses and behaves as local-embedder-attempted (AC-7 / NFR-6). The
  // embedder shape is `kind`-based to match the discriminated `EmbedderConfig`
  // the context factory consumes; `resolveEmbedderConfig` (@noir-ai/context) is
  // the single bridge from this user-facing schema to the factory input, so core
  // never imports context (no core→context cycle). Provider-explicit, NEVER
  // silent remote (blueprint D6): `kind:'remote'`/`'ollama'` are opt-in only;
  // the default `'local'` is in-process, offline, free, private.
  context: z
    .object({
      embedder: z
        .object({
          kind: z.enum(['local', 'remote', 'ollama', 'none']).default('local'),
          // HF repo id (local) / provider model id (remote) / Ollama tag.
          model: z.string().optional(),
          // Remote provider key, e.g. 'openai' (only meaningful when kind:'remote').
          // Free-form string so openai-compatible providers stay expressible; the
          // resolver maps known names (openai/voyage/cohere) to their API-key env var.
          provider: z.string().optional(),
          // Ollama base URL, e.g. http://localhost:11434 (only when kind:'ollama').
          baseURL: z.string().optional(),
          // Target dimensionality — must be 384 to match the existing vec0 table.
          dim: z.number().int().positive().default(384),
        })
        .default({ kind: 'local', dim: 384 }),
      // Configured index roots (informational in core; the daemon/indexer consume).
      roots: z.array(z.string()).default([]),
      // Default token budget for a `context_search` result set (retriever default).
      budgetTokens: z.number().int().positive().default(4096),
    })
    // Zod v4 requires the outer default to match the parsed output shape (every
    // inner field already carries its own default, so an absent `context:` block
    // still resolves to local-embedder/empty-roots/4096). Mirrors `daemon:`.
    .default({ embedder: { kind: 'local', dim: 384 }, roots: [], budgetTokens: 4096 }),
  // Slice S8 bounded model layer (@noir-ai/model). Mirrors the `daemon` idiom —
  // a top-level object with `.default({})` so a config with NO `model:` block
  // still parses and behaves as fully-degraded (every `complete()` call returns
  // `null`; callers substitute a template — the always-available offline path,
  // blueprint D5). `resolveModelConfig` (@noir-ai/model) is the single
  // bridge from this user-facing schema to the runtime shape `complete()`
  // consumes, so core never imports model (no core→model cycle).
  //
  // Provider-EXPLICIT, never silent paid (blueprint D5): the provider is
  // resolved ONLY from explicit `defaultProvider` / a tier's provider key. Env-
  // var presence is NEVER consulted to pick a provider — `ANTHROPIC_API_KEY`
  // being set for another tool does NOT activate Anthropic in Noir. No explicit,
  // configured provider ⇒ `null`. Secrets live in env vars only:
  // `apiKeyEnv` stores the env-var NAME (`ANTHROPIC_API_KEY`), never the value,
  // so `.noir/config.yml` stays safe to commit and share; `complete()` reads the
  // value at call time. `tiers` map a tier name → provider block key; each
  // `providers[name]` declares the model id, optional `baseURL` (openai-compat),
  // and optional `apiKeyEnv` (omit for anonymous local providers like Ollama).
  model: z
    .object({
      // Fallback provider name (key into `providers`) when a call's tier resolves
      // no explicit provider. Free-form string so openai-compatible providers stay
      // expressible without an enum churn.
      defaultProvider: z.string().optional(),
      // Per-tier provider-key overrides (draft / title / summarize / consolidate).
      // Each value is a key into `providers{}`; resolution is the consumer's job
      // (tier → tier.provider → defaultProvider → providers[name]).
      tiers: z
        .object({
          draft: z.string().optional(),
          title: z.string().optional(),
          summarize: z.string().optional(),
          consolidate: z.string().optional(),
        })
        .optional(),
      // Configured provider blocks, keyed by name. `model` is required (a provider
      // without a model id is meaningless); `apiKeyEnv` is omitted for anonymous
      // local providers (Ollama / LM Studio) which then send no auth header.
      providers: z
        .record(
          z.string(),
          z.object({
            model: z.string(),
            baseURL: z.string().optional(),
            apiKeyEnv: z.string().optional(),
          }),
        )
        .optional(),
    })
    // Absent `model:` block ⇒ `{}` ⇒ every tier/provider is undefined ⇒ full
    // degradation (offline, free, the default). Inner fields are `.optional()`
    // (no inner `.default()`) so a present-but-empty block also degrades.
    .default({}),
  // Cross-session memory (@noir-ai/memory). Mirrors the `daemon` idiom —
  // a top-level object with `.default({})` so a config with NO `memory:` block
  // still parses and behaves as consolidation-disabled (the safe default —
  // capture/store/retrieve are always local + free; consolidation is the ONLY
  // LLM touch and it is opt-in + provider-explicit). `resolveMemoryConfig`
  // (@noir-ai/memory) is the single bridge from this user-facing schema to the
  // runtime `MemoryConfig` the engine consumes, so core never imports memory
  // (no core→memory cycle; mirrors @noir-ai/context + @noir-ai/model).
  //
  // Provider-EXPLICIT, never silent paid (blueprint D6): the provider is
  // resolved ONLY from explicit `consolidation.provider`. Env-var presence is
  // NEVER consulted to pick a provider — `ANTHROPIC_API_KEY` being set for
  // another tool does NOT activate consolidation. No explicit, enabled provider
  // ⇒ `runConsolidation` refuses with `'no-provider'` + writes a miss audit, and
  // NO S8 `complete()` call is made (the Agent-Memory anti-pattern, §9). The
  // outer default matches the parsed output shape (Zod v4 requirement).
  memory: z
    .object({
      consolidation: z
        .object({
          // Master switch (default false). When false, `consolidate` refuses +
          // logs (`no-provider`) regardless of provider/model — the first gate.
          enabled: z.boolean().default(false),
          // Provider key, e.g. 'anthropic' | 'openai' | 'ollama'. Free-form
          // string so openai-compatible providers stay expressible without an
          // enum churn; required (alongside enabled) for consolidation to run.
          provider: z.string().optional(),
          // Provider-specific model id (consumed by S8 complete(); optional
          // here only because a future anonymous local provider may not need it
          // — runConsolidation still refuses when model is absent).
          model: z.string().optional(),
          // Restrict candidates to these types (default: every non-`lesson`).
          types: z.array(z.string()).optional(),
        })
        // Absent consolidation block ⇒ disabled. Outer shape matches output.
        .default({ enabled: false }),
    })
    .default({ consolidation: { enabled: false } }),
  // Debt-batch A — `rules:` block. Additive, no-op when absent (defaults make it
  // a pass-through). Reserved for the upcoming rule-driven lint surface (the
  // `@noir-ai/workflow` rule registry + future `noir check`); for v1.x this
  // block is parsed + validated but no consumer reads it yet — declaring it
  // here lets early adopters pin `enabled: false` or a non-default budget in
  // `.noir/config.yml` without a schema churn when the rule engine ships.
  rules: z
    .object({
      // Master switch (default true — the rule registry is opt-OUT; a project
      // that wants no part of it sets `enabled: false`). When the rule engine
      // ships, false ⇒ no rules registered + `noir check` is a no-op.
      enabled: z.boolean().default(true),
      // Soft per-rule body budget in KB (targets file-size discipline for the
      // markdown rules; the future rule registry clips over-budget rule bodies
      // and surfaces a warning rather than rejecting the file). Positive int.
      lengthBudgetKb: z.number().int().positive().default(6),
    })
    // Outer default matches the parsed output shape (Zod v4 requirement): an
    // absent `rules:` block resolves to enabled/6 — the registry-active default.
    .default({ enabled: true, lengthBudgetKb: 6 }),
  // Slice P (PRD) — `prd:` block. Additive, escapable-soft-gate config for the
  // pre-SDD Product Requirements Document. The workflow engine reads
  // `mandatoryFor` to decide when a missing PRD warrants an observable,
  // escapable recommendation at the spec gate (the advance still proceeds —
  // never a hard block; `--force <reason>` is the explicit override). The
  // `TaskClass` enum mirrors @noir-ai/workflow's; duplicated HERE (as a literal
  // z.enum) so core never imports workflow (no core→workflow cycle), exactly
  // as `model`/`memory`/`context` declare provider shapes that their resolvers
  // in other packages consume.
  //
  // Defaults: `mandatoryFor: ['feature', 'epic']` — the noir-prd skill's "when
  // to draft" rule. Quick-mode + non-mandatory taskClasses skip the check
  // entirely; a present-but-empty `prd:` block also degrades to the default.
  prd: z
    .object({
      mandatoryFor: z
        .array(
          z.enum(['feature', 'epic', 'enhancement', 'bugfix', 'spike', 'quick-task', 'refactor']),
        )
        .default(['feature', 'epic']),
    })
    .default({ mandatoryFor: ['feature', 'epic'] }),
  // Slice X integration layer (@noir-ai/skills `integrations/<name>/`). Additive
  // block keyed by integration name — every field optional + default-`{}` so a
  // config with NO `integrations:` block still parses and behaves as "no
  // integrations wired" (degraded by default; the skill playbook still ships
  // and works in manual-paste mode regardless of this block — it only carries
  // the per-workspace binding like team_id/list_id for the gated proxy). The
  // declaration shape lives in @noir-ai/skills' Zod schema; this block is the
  // USER-facing overlay (which integration is enabled + where it points), not
  // a re-statement of the declaration.
  //
  // Doctrine (slice-x spec + Q4b): the auth TOKEN stays in env (tokenEnv name
  // is declared in integration.json, NOT here); ClickUp-specific ids are
  // optional workspace binding; `runtime` mirrors the declaration tiers so a
  // user can DOWNGRADE an integration locally (e.g. force `none` for a
  // read-only run).
  integrations: z
    .record(
      z.string(),
      z.object({
        auth: z
          .object({
            // Override the token env var name (defaults to the declaration's
            // `auth.tokenEnv` when undefined). Min(1) matches the declaration
            // schema's invariant (`integrations-schema.ts` tokenEnv is non-empty)
            // — an empty-string override must FAIL validation, not silently
            // disable the integration (env[''] is always undefined).
            tokenEnv: z.string().min(1).optional(),
          })
          .partial()
          .default({}),
        runtime: z.enum(['none', 'gated-write-proxy', 'mcp-stdio', 'external-mcp']).default('none'),
        // ClickUp-workspace binding (optional; flows 3 + 5 need a list_id).
        teamId: z.string().optional(),
        listId: z.string().optional(),
        spaceId: z.string().optional(),
      }),
    )
    .default({}),
});

export type NoirConfig = z.infer<typeof NoirConfigSchema>;

export function parseConfig(raw: unknown): NoirConfig {
  return NoirConfigSchema.parse(raw);
}

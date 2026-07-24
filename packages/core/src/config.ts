import * as z from 'zod/v4';

export const NoirConfigSchema = z.object({
  host: z.literal('claude'),
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
});

export type NoirConfig = z.infer<typeof NoirConfigSchema>;

export function parseConfig(raw: unknown): NoirConfig {
  return NoirConfigSchema.parse(raw);
}

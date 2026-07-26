// `integration.json` schema. Each integration ships a declaration
// alongside its `SKILL.md` so the compiler can validate the auth/runtime/SDD
// contract uniformly and so the host adapter knows whether to widen emission
// (host MCP config) or stay skill-only.
//
// Doctrine (slice-x spec §architecture + v1x §4.4): skill-only by default;
// `gated-write-proxy` for stateless writes routed through a Noir MCP tool
// `mcp-stdio` for a Noir-spawned stateful runtime (deferred, gated on
// keychain); `external-mcp` for a config-only pointer at a first-party/community
// MCP server (emits a host `.mcp.json` server entry, no Noir runtime).
//
// Zod v4 (`z.record(keyType, valueType)` is key-first). The schema is additive
// and defaults to the safest tier — every optional field degrades to "skill
// only, manual paste, no host MCP wiring" — so a minimal `{ "name":
// "noir-x" }` declaration still parses + behaves as a pure playbook.

import * as z from 'zod';

/** Auth shape. Locked: `env-var` only until keychain lands (Q4b — refuse OAuth,
 *  never silently lower the security bar). `fallback:'manual-paste'` keeps the
 *  no-token path honest (the playbook tells the user to paste a value); `'none'`
 *  is for integrations that genuinely do not need a token (read-only public
 *  endpoints). */
export const IntegrationAuthSchema = z.object({
  type: z.literal('env-var'),
  tokenEnv: z.string().min(1),
  fallback: z.enum(['manual-paste', 'none']).default('manual-paste'),
});

/** SDD two-way binding. `intakeFrom` declares the external artifact kind the
 *  `noir-intake` skill pulls from; `writeBack` enumerates the fields
 *  `noir-wrap`/`noir-document` push back at session end. Strings (not enums)
 *  for `writeBack` so a per-integration vocabulary stays expressible without
 *  churning the schema. */
export const IntegrationSddSchema = z
  .object({
    intakeFrom: z.enum(['task', 'issue', 'none']).optional(),
    writeBack: z.array(z.string()).default([]),
  })
  .default({ writeBack: [] });

/** Host MCP declaration. Only meaningful when `runtime ∈ {mcp-stdio,
 *  external-mcp}`; `null` for `none`/`gated-write-proxy` (ClickUp — writes go
 *  through Noir's own MCP tool, never the host's). */
export const IntegrationMcpSchema = z
  .object({
    command: z.string().min(1),
    transport: z.enum(['stdio', 'http']),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .nullable()
  .default(null);

/** Full `integration.json` declaration. `name` enforces the `noir-` prefix
 *  shared with builtins so the unified pack reads consistently. */
export const IntegrationDeclarationSchema = z.object({
  name: z.string().regex(/^noir-[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must match noir-<kebab>'),
  auth: IntegrationAuthSchema,
  runtime: z.enum(['none', 'gated-write-proxy', 'mcp-stdio', 'external-mcp']),
  sdd: IntegrationSddSchema,
  mcp: IntegrationMcpSchema,
});

export type IntegrationDeclaration = z.infer<typeof IntegrationDeclarationSchema>;

/** Coerce + validate an `integration.json` payload. Throws a ZodError on a
 *  malformed declaration — the caller (discover) wraps it with the
 *  integration's dir for an actionable message. */
export function parseIntegration(json: unknown): IntegrationDeclaration {
  return IntegrationDeclarationSchema.parse(json);
}

/** Non-throwing variant for the hygiene tests + lint helpers. */
export function validateIntegration(
  obj: unknown,
): { ok: true; value: IntegrationDeclaration } | { ok: false; errors: string[] } {
  const parsed = IntegrationDeclarationSchema.safeParse(obj);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i: { message: string }) => i.message) };
}

/** Runtime → host-MCP emission predicate. The compiler widens emission (makes
 *  the host MCP block available to the adapter) ONLY for these tiers. The
 *  adapter ultimately decides per-host what to render — for Claude, `external-
 *  mcp` becomes a `.mcp.json` server entry; `mcp-stdio` registers through the
 *  existing `noir mcp serve --stdio` entry so no NEW server entry is emitted. */
export function runtimeEmitsHostMcp(runtime: IntegrationDeclaration['runtime']): boolean {
  return runtime === 'mcp-stdio' || runtime === 'external-mcp';
}

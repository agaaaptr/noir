// Slice X — integration runtime seam (X-T3). The daemon-side companion to the
// shipped `integration.json` declarations (X-T1) + the core `integrations` config
// block (X-T2). This module is deliberately split into THREE concerns so the
// security-critical paths can be unit-tested in isolation:
//
//   1. `IntegrationService` — the per-serve-lifecycle handle built ONCE from the
//      discovered declarations (@noir-ai/skills `discoverIntegrations`) and held
//      on `ctx.integrations` (mirrors `ctx.store` / `ctx.engine` / `ctx.memory`).
//      Discovery is best-effort: a missing/unreadable pack degrades to an empty
//      service (the `integrations_auth` tool still resolves a caller-supplied
//      `envVar`; `noir.clickup_write` is simply not registered).
//   2. `resolveToken` — the ONLY place a token value touches process.env. Read
//      at call time, returned to the calling agent, NEVER logged/echoed to
//      stderr/audit bodies (the token travels only in the tool RESULT to the
//      trusted host + the outbound `Authorization` header).
//   3. `writeIntegrationAudit` — append-only JSONL into the SAME `.noir/audit/`
//      dir as the S4 gate export (X-OQ2 resolved: REUSE, do not invent a new
//      audit location). One executed write ⇒ one line; dry-runs are NOT audited.
//
// Doctrine: graceful degradation (no-token ⇒ manual-paste / no-token refuse,
// never a crash); `.noir/` SOT (audit there); NO silent writes (the confirm gate
// lives in the proxy module + the tool handler, never here).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import type { IntegrationDeclaration } from '@noir-ai/skills';
import { discoverIntegrations } from '@noir-ai/skills';

/**
 * Per-integration binding resolved at the seam: the shipped declaration (source
 * of truth for `auth.tokenEnv` + `runtime`) merged with the user's
 * `integrations.<name>` config overlay (source of truth for `teamId`/`listId`/
 * `spaceId` + a local `auth.tokenEnv` override / `runtime` downgrade). The
 * declaration is authoritative for `tokenEnv` unless the config explicitly
 * overrides it (a workspace that renamed the env var).
 */
export interface IntegrationBinding {
  /** Full declaration name, e.g. `'noir-clickup'`. */
  name: string;
  /** Short name — declaration name with the `noir-` namespace stripped
   *  (`'clickup'`). The `noir.clickup_write` tool segment + the documented
   *  `integrations.clickup.*` config key both use this form. */
  shortName: string;
  declaration: IntegrationDeclaration;
  /** Resolved token env-var name (config override > declaration). */
  tokenEnv: string;
  /** Effective runtime tier: the user's `integrations.<name>.runtime` overlay
   *  wins when set, else the declaration's `runtime`. The daemon gates write-tool
   *  registration on THIS (not the declaration's) so a local downgrade to `none`
   *  actually takes the write tool off — the tier model: `none` = skill-side
   *  reads only, `integrations_auth` still resolves the token. */
  effectiveRuntime: IntegrationDeclaration['runtime'];
  teamId?: string;
  listId?: string;
  spaceId?: string;
}

/**
 * The per-serve-lifecycle integration handle. Built once (mirrors the store +
 * workflow + memory engines) and reused across every MCP request. Carries the
 * discovered declarations merged with the user config so the tools never re-read
 * the filesystem per call.
 */
export interface IntegrationService {
  /** Project root — the anchor for `.noir/audit/` writes. */
  root: string;
  /** Bindings keyed by BOTH the full name (`noir-clickup`) and the short name
   *  (`clickup`) so a tool/config using either form resolves the same binding. */
  bindings: Map<string, IntegrationBinding>;
}

/** Strip the `noir-` namespace prefix from a declaration name. The short form
 *  is what the `noir.<short>_write` tool segment + the `integrations.<short>`
 *  config key use; the declaration itself always carries the full `noir-` name. */
export function shortNameOf(name: string): string {
  return name.replace(/^noir-/, '');
}

/**
 * Build the integration service for one serve lifecycle. Discovery is
 * best-effort: a missing/unreadable skills pack ⇒ an empty service (the tools
 * degrade gracefully — `integrations_auth` still resolves a caller `envVar`;
 * `noir.clickup_write` is simply not registered). Never throws.
 *
 * @param root project root (`.noir/audit/` anchor)
 * @param configIntegrations the parsed `integrations` block from `.noir/config.yml`
 *   (`{ [name]: { auth?, runtime, teamId?, listId?, spaceId? } }`). Keys may use
 *   either the full `noir-clickup` or the short `clickup` form.
 */
export function buildIntegrationService(
  root: string,
  configIntegrations: Record<
    string,
    {
      auth?: { tokenEnv?: string };
      runtime?: 'none' | 'gated-write-proxy' | 'mcp-stdio' | 'external-mcp';
      teamId?: string;
      listId?: string;
      spaceId?: string;
    }
  > = {},
): IntegrationService {
  let discovered: IntegrationDeclaration[] = [];
  try {
    discovered = discoverIntegrations().map(
      (s: { declaration: IntegrationDeclaration }) => s.declaration,
    );
  } catch {
    // A malformed shipped declaration would have failed the skills pack's own
    // tests; if we still hit this, degrade to "no integrations wired" rather
    // than crashing the daemon.
    discovered = [];
  }
  const bindings = new Map<string, IntegrationBinding>();
  for (const declaration of discovered) {
    // Config lookup tolerates both `noir-clickup` and `clickup` keys (the docs
    // use the short form; the full form is accepted for symmetry).
    const cfg =
      configIntegrations[declaration.name] ?? configIntegrations[shortNameOf(declaration.name)];
    const tokenEnv = cfg?.auth?.tokenEnv ?? declaration.auth.tokenEnv;
    // Effective runtime: the user's config overlay wins when set; otherwise the
    // declaration's tier. This is what the daemon must gate write-tool
    // registration on (NOT the declaration's runtime) — a local downgrade to
    // `none` for a read-only run takes the write tool off without touching the
    // shipped declaration.
    const effectiveRuntime = cfg?.runtime ?? declaration.runtime;
    const binding: IntegrationBinding = {
      name: declaration.name,
      shortName: shortNameOf(declaration.name),
      declaration,
      tokenEnv,
      effectiveRuntime,
      ...(cfg?.teamId !== undefined ? { teamId: cfg.teamId } : {}),
      ...(cfg?.listId !== undefined ? { listId: cfg.listId } : {}),
      ...(cfg?.spaceId !== undefined ? { spaceId: cfg.spaceId } : {}),
    };
    bindings.set(binding.name, binding);
    bindings.set(binding.shortName, binding);
  }
  return { root, bindings };
}

/** Look up a binding by either the full or short name. */
export function findBinding(svc: IntegrationService, name: string): IntegrationBinding | undefined {
  return svc.bindings.get(name);
}

/** Result of a token resolution attempt. */
export type TokenResolution =
  | { ok: true; token: string; envVar: string }
  | { ok: false; reason: 'no-token'; envVar: string }
  | { ok: false; reason: 'unknown-integration'; integration: string };

/**
 * Resolve an integration token VALUE from `process.env` at CALL TIME (never at
 * load time; never cached beyond the call). The token is returned to the calling
 * agent in the tool result (trusted host) + travels in the outbound
 * `Authorization` header — and NOWHERE else (no stderr, no audit body).
 *
 * Two call shapes:
 *   - `{ integration: 'noir-clickup' }` → look up `tokenEnv` from the discovered
 *     declaration (config override honored), then read `process.env[tokenEnv]`.
 *   - `{ envVar: 'CLICKUP_API_TOKEN' }` → read `process.env[envVar]` directly.
 */
export function resolveToken(
  svc: IntegrationService,
  opts: { integration?: string; envVar?: string },
  env: NodeJS.ProcessEnv = process.env,
): TokenResolution {
  const integration = opts.integration;
  const envVar = opts.envVar;
  if (integration !== undefined) {
    const binding = findBinding(svc, integration);
    if (!binding) return { ok: false, reason: 'unknown-integration', integration };
    const name = binding.tokenEnv;
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) {
      return { ok: true, token: value, envVar: name };
    }
    return { ok: false, reason: 'no-token', envVar: name };
  }
  if (envVar !== undefined) {
    const value = env[envVar];
    if (typeof value === 'string' && value.length > 0) {
      return { ok: true, token: value, envVar };
    }
    return { ok: false, reason: 'no-token', envVar };
  }
  // Neither integration nor envVar supplied: synthesize a clear refusal rather
  // than a crash. The skill drives the manual-paste fallback from this.
  return { ok: false, reason: 'no-token', envVar: '' };
}

/** One executed-write audit record (X-T3, X-OQ2). Append-only JSONL — one line
 *  per executed write. Dry-runs are NOT audited (no write happened). */
export interface IntegrationAuditEntry {
  /** Fixed discriminator so a future `.noir/audit/` reader can filter mixed
   *  gate (`kind:'gate'`-ish) + integration rows. */
  kind: 'integration';
  /** Declaration name, e.g. `'noir-clickup'`. */
  integration: string;
  /** Op verb (normalized short form): `status` | `subtask` | `comment` | `batch`. */
  op: string;
  /** Stable target descriptor (e.g. `'task/abc123'`, `'list/90125/task'`). */
  target: string;
  /** HTTP method on the allowlisted endpoint. */
  method: string;
  /** HTTP status returned by ClickUp (last attempt after 429 backoff). */
  httpStatus: number;
  /** True iff `httpStatus` is 2xx. */
  success: boolean;
  /** Epoch-millis when the write was attempted. */
  timestamp: number;
  /** Present when a 429 backoff fired (the spec calls for recording the wait). */
  rateLimitedWaitMs?: number;
  /** Error message when `success === false` (NEVER includes the token). */
  error?: string;
}

/**
 * Append one integration audit record to `.noir/audit/integration-<short>.jsonl`
 * (the SAME `.noir/audit/` dir as the S4 gate export — X-OQ2 resolved: REUSE).
 * Append-only JSONL so concurrent/sequential writes don't clobber each other and
 * the file grows linearly with executed writes. Creates the dir if missing.
 *
 * Propagates filesystem errors to the caller — the gated proxy's handler is the
 * best-effort boundary: it catches, sets the result envelope's `audited:false`,
 * and continues (the ClickUp write already happened; an audit failure does NOT
 * roll it back). Keeping the throw honest makes `audited:false` reachable instead
 * of a perpetually-true flag.
 */
export function writeIntegrationAudit(
  root: string,
  integrationName: string,
  entry: IntegrationAuditEntry,
): void {
  // X-OQ2 resolved: REUSE the S4 `.noir/audit/` dir (SOT — no second audit
  // location). Integration writes are append-only + cross-task (not keyed by a
  // Noir task id), so a per-integration JSONL file is the natural shape: one
  // executed write ⇒ one line. The `.jsonl` extension keeps it distinct from
  // the per-task `.json` exports.
  const file = join(paths.auditDir(root), `integration-${shortNameOf(integrationName)}.jsonl`);
  mkdirSync(paths.auditDir(root), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
}

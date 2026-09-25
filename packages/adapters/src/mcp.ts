import { join } from 'node:path';
import { resolveAdapter } from './index.js';
import type { HostAdapter, HostId, IntegrationMcpEmission, McpConfigOptions } from './types.js';

/**
 * The keys that say HOW a host reaches the Noir server — `command`/`args` for
 * stdio, `type`/`url` for the http endpoint. Rewriting the transport replaces
 * exactly these, so an entry never ends up describing two transports at once,
 * and everything else the entry carries (`env`, `headers`, `headersHelper`, …)
 * is the user's and is kept. Exported once here (beside `noirStdioArgs`) and
 * shared by the cli's workspace rewrite and the create scaffold migration,
 * which both strip these keys — the set must never be re-declared there.
 */
export const TRANSPORT_KEYS: ReadonlySet<string> = new Set(['command', 'args', 'type', 'url']);

/**
 * Where a host keeps its MCP config file (absolute), with the `.mcp.json`
 * default a host that does not declare a path falls back to. Every adapter's
 * `mcpConfigPath` reads `root` and nothing else from its context, so a caller
 * that holds no adapter object asks by host id and this is where the fallback
 * lives — one expression, not one per caller.
 */
export function mcpConfigPathForAdapter(adapter: HostAdapter, root: string): string {
  return adapter.mcpConfigPath?.({ root }) ?? join(root, '.mcp.json');
}

/** {@link mcpConfigPathForAdapter} for a caller that has the host id rather than
 *  the adapter object — it resolves the adapter first. The cli's workspace
 *  rewrite, its `doctor` expectation check, and the create scaffold migration
 *  all come through here; the create manifest, which already holds the adapter,
 *  calls the adapter form directly. Either way the fallback is spelled once. */
export function mcpConfigPathFor(host: HostId, root: string): string {
  return mcpConfigPathForAdapter(resolveAdapter(host), root);
}

/**
 * The arguments that start Noir's MCP server over stdio. A repo that has joined
 * a workspace names it here, so the host spawns the bridge, which resolves the
 * workspace daemon and reads its token itself — the entry never has to carry an
 * address or a secret. Shared by every host adapter (OpenCode carries the same
 * argv in a single `command` array) and by the scaffold upgrade that rewrites a
 * stale entry, so the invocation is spelled in exactly one place.
 */
export function noirStdioArgs(workspace?: string): string[] {
  return workspace === undefined
    ? ['mcp', 'serve', '--stdio']
    : ['mcp', 'serve', '--stdio', '--workspace', workspace];
}

/**
 * Build the host MCP config JSON string — the `{mcpServers: {...}}` shape shared
 * by claude (`.mcp.json`), agents-md (`.mcp.json`), gemini (`.gemini/mcp.json`),
 * and cursor (`.cursor/mcp.json`). OpenCode uses a DIFFERENT shape (an `mcp`
 * block with `type`-tagged entries) and does NOT use this helper — see
 * `opencode.ts`.
 *
 * The Noir server entry is always present; an optional integration entry merges
 * alongside it (per the adapter contract — only `external-mcp`
 * integrations surface a `hostMcp` block by the time it reaches here).
 *
 * Refactored out of `claude.ts` so every `{mcpServers}`-shape
 * host emits byte-identical JSON. Claude's `emitMcpConfig` now delegates here
 * (the claude.test.ts + create/scaffold.test.ts parity gates must hold).
 *
 * Stdio entry: `{ command, args }`.
 * HTTP entry : `{ type: 'http', url, [env] }` — env nested under `env:`, never
 * spread at the entry top level (would corrupt the server-field shape).
 */
export function buildMcpServersJson(
  opts: McpConfigOptions,
  integration?: IntegrationMcpEmission,
): string {
  // Always present: the Noir MCP server — `noir mcp serve --stdio` or the
  // streamable-http endpoint. The placeholder URL (`:0`) is a best-effort hint
  // the user edits; same behavior as the original claude implementation.
  // For stdio, `command` defaults to 'noir' but the engine passes the absolute
  // native-shim path when a native install is detected — GUI MCP clients (VS
  // Code, Cursor) launch from the Dock/Finder and don't read shell profiles, so
  // a bare 'noir' fails with `spawn noir ENOENT` even when ~/.noir/bin is on
  // the user's shell PATH. See resolveNoirCommand() in @noir-ai/core.
  const noirServer =
    opts.transport === 'stdio'
      ? { command: opts.command ?? 'noir', args: noirStdioArgs(opts.workspace) }
      : { type: 'http', url: opts.url ?? 'http://127.0.0.1:0/mcp' };

  const mcpServers: Record<string, unknown> = { noir: noirServer };
  if (integration) {
    const entry =
      integration.transport === 'http'
        ? {
            type: 'http',
            url: integration.url ?? '',
            // Nest env under `env:` (NOT spread at the entry top level) so the
            // emitted shape matches the stdio branch + Claude's spec. Top-level
            // spread would leak env keys as server fields.
            ...(integration.env ? { env: integration.env } : {}),
          }
        : {
            command: integration.command,
            ...(integration.args ? { args: integration.args } : {}),
            ...(integration.env ? { env: integration.env } : {}),
          };
    mcpServers[integration.serverName] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

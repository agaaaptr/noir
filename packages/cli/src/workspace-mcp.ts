// `.mcp.json` rewrite/restore for workspace membership — the ONLY user-facing
// file a join/leave touches. It rewrites just the `noir` server entry (preserving
// every other server the user added) and refuses to clobber a config that does
// not look Noir-emitted unless `--force` (never a silent overwrite).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import { atomicWriteFile, resolveNoirCommand } from '@noir-ai/core';
import { type CliOptions, EXIT, fail } from './output.js';

function mcpPathFor(root: string, host: HostId): string {
  return resolveAdapter(host).mcpConfigPath?.({ root }) ?? join(root, '.mcp.json');
}

/** Read + parse an existing host MCP config, or `null` when the file is absent. */
function readJson(path: string): { mcpServers?: Record<string, unknown> } | null {
  if (!existsSync(path)) return null; // absent → fresh write is fine
  // Unparseable (JSONC/commented/trailing-comma) THROWS so the caller can refuse —
  // never silently clobber a user-edited file that happens to not be strict JSON.
  return JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> };
}

/** Load an existing config, refusing (exit 1) on an unparseable file unless --force. */
function loadExisting(
  path: string,
  opts: CliOptions & { force?: boolean },
): { mcpServers?: Record<string, unknown> } | null {
  let existing: { mcpServers?: Record<string, unknown> } | null;
  try {
    existing = readJson(path);
  } catch {
    if (opts.force !== true) {
      fail(
        EXIT.ERROR,
        `Refusing to rewrite ${path}: it is not valid JSON (add --force to overwrite).`,
        opts,
      );
    }
    existing = null; // --force: overwrite the unparseable file
  }
  if (existing !== null && !isNoirEmitted(existing.mcpServers) && opts.force !== true) {
    fail(
      EXIT.ERROR,
      `Refusing to rewrite ${path}: it does not look like a Noir-emitted config (add --force to overwrite).`,
      opts,
    );
  }
  return existing;
}

function isNoirEmitted(mcpServers: Record<string, unknown> | undefined): boolean {
  const noir = mcpServers?.noir as { command?: unknown; type?: unknown } | undefined;
  if (!noir) return false;
  if (typeof noir.command === 'string') return true;
  return noir.type === 'http';
}

/** Point the repo's `noir` MCP entry at the workspace daemon (with the member `?p=` identity). */
export function writeWorkspaceHttpEntry(
  root: string,
  host: HostId,
  url: string,
  projectId: string,
  opts: CliOptions & { force?: boolean },
): void {
  const path = mcpPathFor(root, host);
  const existing = loadExisting(path, opts);
  const next = {
    ...(existing ?? {}),
    mcpServers: {
      ...(existing?.mcpServers ?? {}),
      noir: { type: 'http', url: `${url}?p=${projectId}` },
    },
  };
  atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** Restore the repo's `noir` MCP entry to stdio (used by `workspace leave`). */
export function writeStdioEntry(
  root: string,
  host: HostId,
  opts: CliOptions & { force?: boolean },
): void {
  const path = mcpPathFor(root, host);
  const existing = loadExisting(path, opts);
  const noir = { command: resolveNoirCommand(), args: ['mcp', 'serve', '--stdio'] };
  const next = { ...(existing ?? {}), mcpServers: { ...(existing?.mcpServers ?? {}), noir } };
  atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

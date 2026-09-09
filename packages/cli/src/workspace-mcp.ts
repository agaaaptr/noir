// `.mcp.json` rewrite/restore for workspace membership — the ONLY user-facing
// file a join/leave touches. It rewrites just the `noir` server entry (preserving
// every other server the user added) and refuses to clobber a config that does
// not look Noir-emitted unless `--force` (never a silent overwrite).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAdapter, type HostId } from '@noir-ai/adapters';
import { resolveNoirCommand } from '@noir-ai/core';
import { type CliOptions, EXIT, fail } from './output.js';

function mcpPathFor(root: string, host: HostId): string {
  return resolveAdapter(host).mcpConfigPath?.({ root }) ?? join(root, '.mcp.json');
}

function readJson(path: string): { mcpServers?: Record<string, unknown> } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> };
  } catch {
    return null;
  }
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
  const existing = readJson(path);
  if (existing !== null && !isNoirEmitted(existing.mcpServers) && opts.force !== true) {
    fail(EXIT.ERROR, `Refusing to rewrite ${path}: it does not look like a Noir-emitted config (add --force to overwrite).`, opts);
  }
  const next = {
    ...(existing ?? {}),
    mcpServers: { ...(existing?.mcpServers ?? {}), noir: { type: 'http', url: `${url}?p=${projectId}` } },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** Restore the repo's `noir` MCP entry to stdio (used by `workspace leave`). */
export function writeStdioEntry(root: string, host: HostId, opts: CliOptions & { force?: boolean }): void {
  const path = mcpPathFor(root, host);
  const existing = readJson(path);
  if (existing !== null && !isNoirEmitted(existing.mcpServers) && opts.force !== true) {
    fail(EXIT.ERROR, `Refusing to rewrite ${path}: it does not look like a Noir-emitted config (add --force to overwrite).`, opts);
  }
  const noir = { command: resolveNoirCommand(), args: ['mcp', 'serve', '--stdio'] };
  const next = { ...(existing ?? {}), mcpServers: { ...(existing?.mcpServers ?? {}), noir } };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

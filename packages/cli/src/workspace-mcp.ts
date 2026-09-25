// `.mcp.json` rewrite/restore for workspace membership — the ONLY user-facing
// file a join/leave touches. It rewrites just the `noir` server entry and refuses
// to clobber a config that does not look Noir-emitted unless `--force` (never a
// silent overwrite). Inside that entry it replaces only the transport (how a host
// reaches the server): every other server in the file, and every other key on the
// entry itself, is kept as the user left it.
import { existsSync, readFileSync } from 'node:fs';
import { type HostId, mcpConfigPathFor, noirStdioArgs, TRANSPORT_KEYS } from '@noir-ai/adapters';
import { atomicWriteFile, resolveNoirCommand } from '@noir-ai/core';
import { type CliOptions, EXIT, fail } from './output.js';

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

/** The `noir` entry as a plain key/value record, or `{}` when there is none (or
 *  it is not an object) — so a merge always has something to spread. */
function noirEntry(mcpServers: Record<string, unknown> | undefined): Record<string, unknown> {
  const noir = mcpServers?.noir;
  if (typeof noir !== 'object' || noir === null || Array.isArray(noir)) return {};
  return noir as Record<string, unknown>;
}

/** Write `transport` onto the repo's `noir` entry, keeping everything else: the
 *  other keys that entry already carried (a user's `env`, `headers`,
 *  `headersHelper`, …) and every other server in the file. */
function writeNoirTransport(
  root: string,
  host: HostId,
  transport: Record<string, unknown>,
  opts: CliOptions & { force?: boolean },
): void {
  const path = mcpConfigPathFor(host, root);
  const existing = loadExisting(path, opts);
  const kept = Object.fromEntries(
    Object.entries(noirEntry(existing?.mcpServers)).filter(([key]) => !TRANSPORT_KEYS.has(key)),
  );
  const next = {
    ...(existing ?? {}),
    mcpServers: {
      ...(existing?.mcpServers ?? {}),
      noir: { ...transport, ...kept },
    },
  };
  atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** Point the repo's `noir` MCP entry at the workspace daemon. The entry stays on
 *  stdio: `noir mcp serve --workspace <name>` resolves the daemon, proves it is
 *  the one the record names, and relays to it with the daemon's own token — so
 *  neither an address nor a secret is written into the repo's config. */
export function writeWorkspaceEntry(
  root: string,
  host: HostId,
  name: string,
  opts: CliOptions & { force?: boolean },
): void {
  writeNoirTransport(
    root,
    host,
    { command: resolveNoirCommand(), args: noirStdioArgs(name) },
    opts,
  );
}

/** Restore the repo's `noir` MCP entry to plain stdio (used by `workspace leave`). */
export function writeStdioEntry(
  root: string,
  host: HostId,
  opts: CliOptions & { force?: boolean },
): void {
  writeNoirTransport(root, host, { command: resolveNoirCommand(), args: noirStdioArgs() }, opts);
}

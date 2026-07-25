import { agentsMdAdapter } from './agents-md-adapter.js';
import { claudeAdapter } from './claude.js';
import { cursorAdapter } from './cursor.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';
import type { HostAdapter, HostId } from './types.js';

export { AGENTS_MD_FILENAME, emitAgentsMd } from './agents-md.js';
export { agentsMdAdapter } from './agents-md-adapter.js';
export { claudeAdapter } from './claude.js';
export { cursorAdapter } from './cursor.js';
export { geminiAdapter } from './gemini.js';
export { buildMcpServersJson } from './mcp.js';
export { opencodeAdapter } from './opencode.js';
export type {
  EmitContext,
  HostAdapter,
  HostId,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

/** The readonly list of supported hosts — derived from the `HostId` union so it
 *  stays in lockstep with the type. Consumers (cli `--host` flag, doctor
 *  reporting) use this for "is this host valid?" + iteration. Order is the
 *  declaration order in `HostId` (claude first — the default).
 *
 *  `Object.freeze` enforces the `readonly` type at runtime — a stray
 *  `SUPPORTED_HOSTS.push('qwen')` from a JS caller fails loudly instead of
 *  silently corrupting the registry list (TS already prevents it in typed code). */
export const SUPPORTED_HOSTS: readonly HostId[] = Object.freeze([
  'claude',
  'agents-md',
  'gemini',
  'cursor',
  'opencode',
]);

/**
 * Resolve a host id to its `HostAdapter`. The registry is a `Record<HostId,
 * HostAdapter>` so the type system enforces completeness — adding a host to
 * `HostId` requires wiring it here (TS errors otherwise). The CLI uses this
 * indirection instead of importing adapters directly so adding a host needs NO
 * CLI edits beyond the `--host` flag's enum.
 *
 * S10-Adapters: all five hosts are now wired —
 *   - `claude`     — CLAUDE.md + `.claude/skills/` + `.mcp.json` (regression anchor).
 *   - `agents-md`  — universal AGENTS.md (the 32-platform baseline).
 *   - `gemini`     — GEMINI.md + AGENTS.md + `.gemini/mcp.json`.
 *   - `cursor`     — AGENTS.md + `.cursor/rules/*.mdc` + `.cursor/mcp.json`.
 *   - `opencode`   — AGENTS.md + `opencode.json` (different MCP shape).
 *
 * Unknown/non-`HostId` strings are impossible to pass at compile time (the
 * signature accepts only `HostId`); the runtime fallback is defensive — a
 * JS caller ignoring types still gets a clear error, not a silent `undefined`.
 */
export function resolveAdapter(host: HostId): HostAdapter {
  switch (host) {
    case 'claude':
      return claudeAdapter;
    case 'agents-md':
      return agentsMdAdapter;
    case 'gemini':
      return geminiAdapter;
    case 'cursor':
      return cursorAdapter;
    case 'opencode':
      return opencodeAdapter;
    default: {
      // Exhaustiveness guard — if `HostId` gains a member and this switch is
      // not updated, TS narrows `host` to `never` here. At runtime (untyped JS
      // callers) we still surface a clear message.
      const _exhaustive: never = host;
      throw new Error(`Unsupported host: ${String(_exhaustive)} (not in registry)`);
    }
  }
}

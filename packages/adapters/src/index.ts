import { claudeAdapter } from './claude.js';
import type { HostAdapter, HostId } from './types.js';

export { AGENTS_MD_FILENAME, emitAgentsMd } from './agents-md.js';
export { claudeAdapter } from './claude.js';
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
 * S10-Foundation state: only `claude` (the regression anchor) is wired. The
 * other four hosts (`agents-md`, `gemini`, `cursor`, `opencode`) ship in
 * S10-Adapters (the next slice); until then, they throw a clear "coming in S10"
 * error so the registry shape is complete but only claude resolves.
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
    case 'gemini':
    case 'cursor':
    case 'opencode':
      // Wired in S10-Adapters (the next slice). Throwing here (rather than
      // returning a stub) keeps the foundation honest: the registry shape is
      // complete, but only claude is callable today.
      throw new Error(`Unsupported host: ${host} (coming in S10)`);
    default: {
      // Exhaustiveness guard — if `HostId` gains a member and this switch is
      // not updated, TS narrows `host` to `never` here. At runtime (untyped JS
      // callers) we still surface a clear message.
      const _exhaustive: never = host;
      throw new Error(`Unsupported host: ${String(_exhaustive)} (not in registry)`);
    }
  }
}

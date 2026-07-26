// Host handoff helpers. The single source for the "open your host CLI"
// directive text shared by the home banner (`noir` bare) and the handoff
// artifact (`noir handoff`). TEXT ONLY — Noir NEVER launches the host (doctrine:
// the host-launch directive is pasteable text, never a spawn). A host that wants
// richer handoff wording implements `HostAdapter.emitHandoff`; the CLI falls
// back to {@link hostLaunchDirective} when that hook is absent.

import type { EmitContext, HandoffPayload, HostId } from './types.js';

/**
 * The readonly host list mirrored from {@link HostId} so this module has NO
 * import edge back to `index.ts` (which re-exports THIS module) — avoids a
 * module-eval cycle. `registry.test.ts` pins `SUPPORTED_HOSTS` to the same five
 * literals, so a new host added to `HostId` surfaces here via that test.
 */
const HOSTS: readonly HostId[] = ['claude', 'agents-md', 'gemini', 'cursor', 'opencode'];

/**
 * One-line host-direction directive (refactored from the home-banner line).
 * Tells the user to open their configured host CLI to do the actual development
 * (Noir is the orchestration/context/memory brain; the host is the execution
 * engine — bring-your-own-agent). Host-agnostic via the {@link HOSTS}
 * registry; lists the alternatives so a multi-host user knows their options.
 *
 * This is the SINGLE source — the home banner AND the handoff artifact both
 * call it so the wording never drifts. A host-specific override lives on
 * {@link HostAdapter.emitHandoff}, not here.
 */
export function hostLaunchDirective(host: HostId): string {
  const others = HOSTS.filter((h) => h !== host);
  return `→ host: ${host}. Open \`${host}\` to start development — Noir set the rules, skills, and memory; ${host} runs the code. (other hosts: ${others.join(', ')})`;
}

/**
 * The default handoff directive block (multi-line) used when a host adapter
 * does NOT implement {@link HostAdapter.emitHandoff}. Composes the generic
 * {@link hostLaunchDirective} line plus a reminder that the MCP wire is already
 * configured (`.mcp.json` / host equivalent), so the host can call Noir's tools
 * the moment it starts. The CLI passes this as the "Open host" portion of the
 * handoff artifact.
 */
export function defaultHandoffBlock(_ctx: EmitContext, payload: HandoffPayload): string {
  const directive = hostLaunchDirective(payload.host);
  return `${directive}\nThe Noir MCP server is already wired via the host's MCP config — call \`noir.*\` tools once \`${payload.host}\` is open.`;
}

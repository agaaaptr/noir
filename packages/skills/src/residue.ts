// Tokens that must NOT survive a port (predecessor plugin internals + upstream
// rhetoric), each with the reason it is forbidden. The list is projected into
// fail-tier hygiene rules, so a token is enforced by the gate and not only by a
// test assertion.
//
// This file is the token table, so it is exempt from the rules it feeds: the
// tokens must appear here to be forbidden anywhere.
// noir-hygiene: exempt

import type { HygieneRule } from './hygiene.js';

interface ResidueToken {
  /** The literal that must not appear in a shipped artifact. */
  token: string;
  /** Why it is forbidden, in a reader's terms. */
  why: string;
}

const RESIDUE: readonly ResidueToken[] = [
  {
    token: 'workflow/<task',
    why: 'Names a state file of the removed workflow plugin, which nothing in this repository reads.',
  },
  {
    token: 'noir-workflow.mode',
    why: 'Names the mode flag of the removed workflow plugin, which nothing in this repository reads.',
  },
  {
    token: 'noir-workflow',
    why: 'Names the removed workflow plugin as a plugin or a path, so a reader following it finds nothing.',
  },
  {
    token: '@uiigateway',
    why: 'Names a package from the project this one was extracted from, which no consumer can resolve.',
  },
  // 'ClickUp'/'clickup' were forbidden while the predecessor plugin was being
  // ported, because the ClickUp REST precedent lived inside it. ClickUp now
  // ships as a first-class integration, so the token names a legitimate
  // subject and is deliberately absent from this list.
  {
    token: '<EXTREMELY-IMPORTANT',
    why: 'Copied rhetorical markup from the upstream tool, which carries no instruction a reader can follow.',
  },
  {
    token: 'SUBAGENT-STOP',
    why: 'Copied rhetorical markup from the upstream tool, which carries no instruction a reader can follow.',
  },
  {
    token: 'plugins/noir-workflow',
    why: 'Names the removed plugin path, which no longer exists in this repository.',
  },
];

/** The forbidden tokens, in the order they are declared. */
export const FORBIDDEN_RESIDUE: readonly string[] = RESIDUE.map((entry) => entry.token);

/** One fail-tier rule per forbidden token. A token matches only when it stands
 *  alone — neither side is a word character or a hyphen — so `noir-workflow`
 *  does not fire inside a longer identifier such as `noir-workflow-engine-`,
 *  which names this repository's own workflow engine rather than the removed
 *  plugin. It still fires on `plugins/noir-workflow/` and `noir-workflow.mode`,
 *  which name the plugin itself; a token that contains another
 *  (`noir-workflow.mode`) is reported by both rules, so the narrower token is
 *  never the only thing matching a line. */
export const RESIDUE_RULES: readonly HygieneRule[] = RESIDUE.map((entry) => ({
  id: `residue-${entry.token
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()}`,
  tier: 'fail' as const,
  pattern: new RegExp(`(?<![\\w-])${escapeForRegExp(entry.token)}(?![\\w-])`),
  rationale: entry.why,
  fix: 'Remove the reference. If it named a mechanism, name the mechanism that replaced it.',
  appliesTo: 'both' as const,
}));

/** Escapes a literal so it can be embedded in a pattern. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

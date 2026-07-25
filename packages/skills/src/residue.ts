// Tokens that must NOT survive a port (predecessor plugin internals + Superpowers
// rhetoric). Shared by the compiler's lint helper and the hygiene tests (T2–T5).
export const FORBIDDEN_RESIDUE: readonly string[] = [
  'workflow/<task', // predecessor state file
  'noir-workflow.mode', // predecessor mode flag
  'noir-workflow', // predecessor plugin name (as a plugin/path reference)
  '@uiigateway', // predecessor Angular specifics
  // NOTE: 'ClickUp'/'clickup' were forbidden during the predecessor-port era (the
  // ClickUp REST precedent lived in the deleted noir-workflow plugin). Slice X
  // reintroduces ClickUp as a first-class Noir integration (skills/integrations/noir-clickup),
  // so the token is no longer residue — it is the integration's legitimate subject.
  '<EXTREMELY-IMPORTANT', // Superpowers rhetoric
  'SUBAGENT-STOP', // Superpowers rhetoric
  'plugins/noir-workflow', // predecessor path
];

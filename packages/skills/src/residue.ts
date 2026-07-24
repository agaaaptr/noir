// Tokens that must NOT survive a port (predecessor plugin internals + Superpowers
// rhetoric). Shared by the compiler's lint helper and the hygiene tests (T2–T5).
export const FORBIDDEN_RESIDUE: readonly string[] = [
  'workflow/<task', // predecessor state file
  'noir-workflow.mode', // predecessor mode flag
  'noir-workflow', // predecessor plugin name (as a plugin/path reference)
  '@uiigateway', // predecessor Angular specifics
  'ClickUp',
  'clickup',
  '<EXTREMELY-IMPORTANT', // Superpowers rhetoric
  'SUBAGENT-STOP', // Superpowers rhetoric
  'plugins/noir-workflow', // predecessor path
];

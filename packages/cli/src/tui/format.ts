// Format the live {@link StatusPayload} as plain text lines for the dashboard's
// output pane. Reuses the SAME describe helpers `noir status` renders with, so
// the dashboard's snapshot and `noir status`'s human table never drift apart.

import {
  describeContext,
  describeDaemon,
  describeMemory,
  describeStore,
  describeWorkflow,
  type StatusPayload,
} from '../commands/status.js';

/**
 * Render a status snapshot as `Label: value` lines. Returns `null` when the
 * payload is absent (the dashboard shows a placeholder in that case).
 */
export function formatStatusPayload(p: StatusPayload | null): string[] | null {
  if (p === null) return null;
  return [
    `Project: ${p.project.name} (${p.project.id})`,
    `Host: ${p.host}`,
    `Noir: ${p.noir}`,
    `Daemon: ${describeDaemon(p.daemon)}`,
    `Store: ${describeStore(p.store)}`,
    `Context: ${describeContext(p.context)}`,
    `Workflow: ${describeWorkflow(p.workflow)}`,
    `Memory: ${describeMemory(p.memory)}`,
  ];
}

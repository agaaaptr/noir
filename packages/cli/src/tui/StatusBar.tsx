// Top status bar. Renders a one-line summary of the live snapshot: host, mode
// (from the active workflow task, if any), phase (or "idle"), and daemon
// health. Degrades cleanly — when the payload is null (project uninitialized,
// snapshot in flight, or the daemon fully down), every field shows a dash and
// the daemon cell reads "down" so the user is never looking at empty space.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusPayload } from '../commands/status.js';
import { c } from '../theme.js';

interface StatusBarProps {
  payload: StatusPayload | null;
  /** When true, the snapshot is being (re)loaded — shown as a dim hint. */
  loading?: boolean;
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): ReactElement {
  return (
    <Text>
      <Text>{c.dim(`${label}:`)}</Text> <Text>{accent ? c.accent(value) : value}</Text>
    </Text>
  );
}

export function StatusBar({ payload, loading }: StatusBarProps): ReactElement {
  const host = payload?.host ?? '—';
  const mode = payload?.workflow?.mode ?? '—';
  const phase = payload?.workflow?.phase ?? (loading ? '…' : 'idle');
  const daemonRunning = payload?.daemon.running === true;
  const daemon = payload === null && loading ? '…' : daemonRunning ? 'up' : 'down';

  return (
    <Text>
      <Cell label="host" value={host} accent />
      <Text>{c.dim(' · ')}</Text>
      <Cell label="mode" value={mode} />
      <Text>{c.dim(' · ')}</Text>
      <Cell label="phase" value={phase} />
      <Text>{c.dim(' · ')}</Text>
      <Text>
        {c.dim('daemon:')} {daemonRunning ? c.ok(daemon) : c.warn(daemon)}
      </Text>
    </Text>
  );
}

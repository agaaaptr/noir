// Top status bar. Renders a one-line summary of the live snapshot: host, mode
// (from the active workflow task, if any), phase (or "idle"), and daemon
// health. Degrades cleanly — when the payload is null (project uninitialized,
// snapshot in flight, or the daemon fully down), every field shows a dash and
// the daemon cell reads "down" so the user is never looking at empty space.
//
// The run screen reuses the same bar with a `run` summary instead of the
// snapshot cells: a host run has no workflow/daemon snapshot to show, and what
// a user needs mid-run is what is streaming — which model, how long, and how
// many tokens have moved.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { StatusPayload } from '../commands/status.js';
import { c } from '../theme.js';

/** The live summary of a host run, when the bar renders the run screen. */
export interface RunProgress {
  /** The model the host announced, or the binary until it has. */
  readonly model: string;
  /** Elapsed time, already humanized (`8s`, `2m 18s`). */
  readonly elapsed: string;
  /** The token cell, already formatted (`↓1,234↑56 tokens`). */
  readonly tokens: string;
  /** How many tool calls the run has started (shown when non-zero). */
  readonly tools?: number;
}

interface StatusBarProps {
  payload: StatusPayload | null;
  /** When true, the snapshot is being (re)loaded — shown as a dim hint. */
  loading?: boolean;
  /** Present on the run screen: render the live run instead of the snapshot. */
  run?: RunProgress;
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

export function StatusBar({ payload, loading, run }: StatusBarProps): ReactElement {
  if (run !== undefined) {
    // The run screen's whole state is the run, so the snapshot cells are
    // replaced by it: `run · model · elapsed · tokens`, with the tool count
    // appended once the host has started working.
    const tools =
      run.tools !== undefined && run.tools > 0
        ? ` · ${run.tools} tool${run.tools === 1 ? '' : 's'}`
        : '';
    return (
      <Text>
        <Cell label="run" value={`${run.model} · ${run.elapsed} · ${run.tokens}${tools}`} accent />
      </Text>
    );
  }

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

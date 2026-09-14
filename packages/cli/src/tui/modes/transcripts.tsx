// The transcript picker (Ctrl+T): open a past run read-only.
//
// A run leaves its raw stream-json in `.noir/transcripts/`, and this screen
// lists the recent ones and re-renders a chosen one through the SAME stream
// fold the live run screen uses — so reopening an old run reads as prose and
// tool activity, not as JSONL. It is deliberately read-only: nothing here can
// change or delete a transcript, because a transcript is the audit record of
// what a host actually did, and that is not something to edit from a list.
//
// The store is a seam: injected, so the picker can be driven in a test against
// an in-memory list and never touches a real `.noir/transcripts/` directory.

import { Box, Text, useInput } from 'ink';
import { type ReactElement, useEffect, useState } from 'react';
import { c } from '../../theme.js';
import { Header } from '../Header.js';
import { TRANSCRIPT_LIST_HINT, TRANSCRIPT_READ_HINT } from '../hints.js';
import { OutputPane } from '../OutputPane.js';
import { Panel } from '../Panel.js';
import { renderTranscript } from '../run-stream.js';
import type { TranscriptEntry, TranscriptStore } from '../transcripts.js';

export interface TranscriptPickerProps {
  readonly transcripts: TranscriptStore;
  readonly onExit: (notice?: string) => void;
  readonly height?: number;
}

type View = { kind: 'list' } | { kind: 'open'; name: string; lines: readonly string[] };

export function TranscriptPicker({
  transcripts,
  onExit,
  height = 14,
}: TranscriptPickerProps): ReactElement {
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    let live = true;
    void transcripts
      .list()
      .then((found) => {
        if (live) setEntries(found);
      })
      .catch(() => {
        // A store that cannot list is "no transcripts yet", not a crash.
        if (live) setEntries([]);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [transcripts]);

  useInput((_input, key) => {
    if (loading) {
      if (key.escape) onExit();
      return;
    }
    if (view.kind === 'list') {
      if (key.escape) {
        onExit();
        return;
      }
      if (key.return) {
        const entry = entries[active];
        if (entry === undefined) return;
        void transcripts
          .read(entry.path)
          .then((lines) => {
            setView({ kind: 'open', name: entry.name, lines: renderTranscript(lines) });
            setScroll(0);
          })
          .catch(() => {
            // A read that fails keeps the list up: the entry is still there,
            // it is just not openable right now.
          });
        return;
      }
      if (key.upArrow) {
        setActive((a) => Math.max(0, a - 1));
        return;
      }
      if (key.downArrow) {
        setActive((a) => Math.min(Math.max(0, entries.length - 1), a + 1));
        return;
      }
      return;
    }
    // An open transcript: scroll, and Esc steps back to the list.
    if (key.escape) {
      setView({ kind: 'list' });
      return;
    }
    if (key.upArrow) setScroll((s) => Math.max(0, s - 1));
    if (key.downArrow) setScroll((s) => s + 1);
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Header tagline="transcripts" />
        <Panel>
          <Box paddingX={1}>
            <Text>{c.dim('loading transcripts…')}</Text>
          </Box>
        </Panel>
        <Text>{c.dim('Esc back')}</Text>
      </Box>
    );
  }

  if (view.kind === 'open') {
    return (
      <Box flexDirection="column">
        <Header tagline={`transcripts · ${view.name}`} />
        <Panel>
          <Box flexDirection="column" paddingX={1}>
            <OutputPane
              lines={view.lines.length > 0 ? view.lines : ['(empty transcript)']}
              scrollOffset={scroll}
              height={height}
              title={view.name}
            />
          </Box>
        </Panel>
        <Text>{c.dim(TRANSCRIPT_READ_HINT)}</Text>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Header tagline="transcripts" />
        <Panel>
          <Box paddingX={1}>
            <Text>{c.dim('no transcripts yet — a run leaves one here')}</Text>
          </Box>
        </Panel>
        <Text>{c.dim('Esc back')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header tagline="transcripts" />
      <Panel>
        <Box paddingX={1}>
          <Text>
            {c.bold('▸ recent transcripts ')}
            <Text>{c.dim('· newest first')}</Text>
          </Text>
        </Box>
        {entries.map((entry, i) => {
          const focused = i === active;
          const when = new Date(entry.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
          const row = `${entry.name} · ${when} · ${entry.sizeBytes} bytes`;
          return (
            <Box key={entry.path} paddingX={1}>
              <Text>{focused ? c.inverse(`▸ ${row}`) : c.dim(`  ${row}`)}</Text>
            </Box>
          );
        })}
      </Panel>
      <Text>{c.dim(TRANSCRIPT_LIST_HINT)}</Text>
    </Box>
  );
}

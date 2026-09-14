// The stream fold: how a host run becomes the lines a pane shows.
//
// Pure and inert by construction (no timers, no I/O), so the two things that
// are easy to get wrong can be pinned exactly: the host reports the same
// assistant text twice — once as deltas, once as the completed block — and a
// run that stops mid-block must keep the words it already produced. The same
// fold re-renders a transcript read back from disk, so a reopen reads as prose
// rather than as JSONL.

import { describe, expect, it } from 'vitest';
import type { NoirEvent } from '../../src/orchestrator.js';
import { RunStream, renderTranscript } from '../../src/tui/run-stream.js';

/** Fold a list of events and return the snapshot. */
function fold(events: readonly NoirEvent[]): ReturnType<RunStream['snapshot']> {
  const stream = new RunStream();
  for (const event of events) stream.apply(event);
  return stream.snapshot();
}

describe('run stream fold', () => {
  it('replaces provisional delta text with the block that confirms it', () => {
    const stream = new RunStream();
    stream.apply({ kind: 'delta', text: 'The fix ' });
    stream.apply({ kind: 'delta', text: 'is in parser.ts.' });
    expect(stream.snapshot().lines).toEqual(['The fix is in parser.ts.']);

    // The completed block repeats those words verbatim.
    stream.apply({ kind: 'assistant', messageId: 'msg_1', text: 'The fix is in parser.ts.' });
    expect(stream.snapshot().lines).toEqual(['The fix is in parser.ts.']);
    expect(stream.snapshot().answer).toBe('The fix is in parser.ts.');
  });

  it('keeps the partial text of a run that stopped mid-block', () => {
    const stream = new RunStream();
    stream.apply({ kind: 'delta', text: 'Starting to explain' });
    stream.finalize();
    expect(stream.snapshot().lines).toEqual(['Starting to explain']);
    expect(stream.snapshot().answer).toBe('Starting to explain');
  });

  it('renders tool activity in arrival order and counts it', () => {
    const snapshot = fold([
      { kind: 'init', sessionId: 'sess-1', model: 'claude-sonnet-4' },
      { kind: 'tool', name: 'Read' },
      { kind: 'assistant', messageId: 'msg_1', text: 'Found it.' },
      { kind: 'tool', name: 'Bash' },
    ]);
    expect(snapshot.lines).toEqual(['● Read', 'Found it.', '● Bash']);
    expect(snapshot.toolCount).toBe(2);
    expect(snapshot.sessionId).toBe('sess-1');
    expect(snapshot.model).toBe('claude-sonnet-4');
  });

  it('never accumulates API-error text as the answer', () => {
    const snapshot = fold([
      { kind: 'assistant', text: 'Not logged in · Please run /login', isError: true },
    ]);
    expect(snapshot.answer).toBe('');
    expect(snapshot.lines).toEqual([]);
  });

  it('splits a multi-line answer into one row per line', () => {
    const snapshot = fold([
      { kind: 'assistant', messageId: 'msg_1', text: 'First line\nSecond line\n' },
    ]);
    expect(snapshot.lines).toEqual(['First line', 'Second line']);
  });

  it('counts the tokens the host reports, without double-counting a message', () => {
    const snapshot = fold([
      {
        kind: 'assistant',
        messageId: 'msg_1',
        text: 'one',
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      {
        kind: 'assistant',
        messageId: 'msg_1',
        text: 'two',
        usage: { inputTokens: 100, outputTokens: 25 },
      },
    ]);
    // The host's usage is cumulative per message id: the later report wins.
    expect(snapshot.inputTokens).toBe(100);
    expect(snapshot.outputTokens).toBe(25);
  });
});

describe('transcript re-render', () => {
  it('renders raw stream-json as the prose and tool rows the run showed', () => {
    const lines = renderTranscript([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'The parser' },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'The parser is fixed.' }] },
      }),
    ]);
    expect(lines).toEqual(['● Read', 'The parser is fixed.']);
  });

  it('skips a line it cannot parse instead of losing the rest', () => {
    const lines = renderTranscript([
      'not json at all',
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Still here.' }] },
      }),
    ]);
    expect(lines).toEqual(['Still here.']);
  });

  it('renders an empty transcript as no rows', () => {
    expect(renderTranscript([])).toEqual([]);
  });
});

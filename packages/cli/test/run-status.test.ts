// Unit tests for the `noir run` status line and the host-stderr tail that a
// failure report carries. No terminal, no host, no clock: the line takes its
// stream, its clock, and its TTY answers as inputs, so every branch — the
// machine-output silence, the two-marker pipe form, the in-place redraw, and
// the shared-cursor rule — is exercised deterministically here.
import { describe, expect, it } from 'vitest';
import {
  HOST_STDERR_TAIL_LINES,
  hostStderrTail,
  humanizeElapsed,
  RunStatusLine,
  type RunStatusOptions,
} from '../src/run-status.js';

/** A status line writing into an array, with a hand-cranked clock. */
function harness(over: Partial<RunStatusOptions> = {}) {
  const writes: string[] = [];
  let clock = 0;
  const status = new RunStatusLine({
    host: 'claude',
    stderrIsTty: true,
    stdoutSharesCursor: true,
    write: (chunk) => writes.push(chunk),
    now: () => clock,
    ...over,
  });
  return {
    status,
    writes,
    text: () => writes.join(''),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const ESC = '\x1b';

describe('humanizeElapsed', () => {
  it('reads seconds under a minute, minutes and seconds above it', () => {
    expect(humanizeElapsed(0)).toBe('0s');
    expect(humanizeElapsed(8_400)).toBe('8s');
    expect(humanizeElapsed(59_999)).toBe('59s');
    // 125 raw seconds is exactly the unreadable form this avoids.
    expect(humanizeElapsed(125_000)).toBe('2m 05s');
    expect(humanizeElapsed(138_000)).toBe('2m 18s');
  });

  it('rolls up to hours with padded minutes', () => {
    expect(humanizeElapsed(3_600_000)).toBe('1h 00m');
    expect(humanizeElapsed(3_725_000)).toBe('1h 02m');
  });

  it('never renders a negative duration', () => {
    expect(humanizeElapsed(-5_000)).toBe('0s');
  });
});

describe('RunStatusLine — gating', () => {
  it('emits nothing under --json, on a terminal or a pipe', () => {
    for (const stderrIsTty of [true, false]) {
      const h = harness({ json: true, stderrIsTty });
      h.status.begin();
      h.status.event({ kind: 'init', model: 'claude-sonnet-4' });
      h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 10 } });
      h.status.event({ kind: 'result', isError: false });
      h.status.end();
      expect(h.writes).toEqual([]);
    }
  });

  it('emits nothing under --quiet, on a terminal or a pipe', () => {
    for (const stderrIsTty of [true, false]) {
      const h = harness({ quiet: true, stderrIsTty });
      h.status.begin();
      h.status.event({ kind: 'assistant', messageId: 'm1' });
      h.status.end();
      expect(h.writes).toEqual([]);
    }
  });

  it('replaces the animated line with two plain markers when stderr is a pipe', () => {
    const h = harness({ stderrIsTty: false });
    h.status.begin();
    h.status.event({ kind: 'init', model: 'claude-sonnet-4' });
    h.advance(138_000);
    h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 120 } });
    h.status.end();
    // Exactly two lines: the spawn is never silent, and the pipe gets no
    // cursor control at all.
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]).toBe('▶ claude · waiting for first event…\n');
    expect(h.writes[1]).toBe('● claude-sonnet-4 · 2m 18s · ↓120↑0 tokens\n');
    expect(h.text()).not.toContain(ESC);
  });

  it('redraws in place, one write per event boundary, when stderr is a terminal', () => {
    const h = harness();
    h.status.begin();
    expect(h.writes).toEqual([`\r${ESC}[K▶ claude · waiting for first event…`]);
    h.status.event({ kind: 'init', model: 'claude-sonnet-4' });
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]).toBe(`\r${ESC}[K▶ claude · claude-sonnet-4 · 0s`);
    // No newline is ever emitted while the row is ours: the next redraw has to
    // land on the same row.
    expect(h.text()).not.toContain('\n');
  });

  it('ignores events it cannot render and does not rewrite an unchanged row', () => {
    const h = harness();
    h.status.begin();
    h.status.event({ kind: 'other' });
    h.status.event({ kind: 'init', model: 'm' });
    h.status.event({ kind: 'init', model: 'm' }); // same clock, same text → no rewrite
    expect(h.writes).toHaveLength(2);
    h.advance(1_000);
    h.status.event({ kind: 'init', model: 'm' }); // the clock moved: a real tick
    expect(h.writes).toHaveLength(3);
  });
});

describe('RunStatusLine — content', () => {
  it('names the model once the host announces it', () => {
    const h = harness();
    h.status.begin();
    h.advance(1_000);
    h.status.event({ kind: 'init', model: 'claude-opus-4', sessionId: 's1' });
    expect(h.writes.at(-1)).toContain('▶ claude · claude-opus-4 · 1s');
  });

  it('shows running token totals on assistant events', () => {
    const h = harness();
    h.status.begin();
    h.status.event({ kind: 'init', model: 'm' });
    h.advance(3_000);
    h.status.event({
      kind: 'assistant',
      messageId: 'msg-1',
      text: 'hi',
      usage: { inputTokens: 1_200, outputTokens: 340 },
    });
    const tokens = `${(1_200).toLocaleString()}↑${(340).toLocaleString()}`;
    expect(h.writes.at(-1)).toBe(`\r${ESC}[K● m · 3s · ↓${tokens} tokens`);
  });

  it('applies the max-per-message rule, so the live total matches the final summary', () => {
    const h = harness();
    h.status.begin();
    // One assistant message arrives as several lines, each carrying the
    // CUMULATIVE usage of that message — summing them would over-count.
    h.status.event({ kind: 'assistant', messageId: 'msg-1', usage: { inputTokens: 100 } });
    h.status.event({
      kind: 'assistant',
      messageId: 'msg-1',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    h.status.event({
      kind: 'assistant',
      messageId: 'msg-1',
      usage: { inputTokens: 100, outputTokens: 250 },
    });
    h.status.event({
      kind: 'assistant',
      messageId: 'msg-2',
      usage: { inputTokens: 30, outputTokens: 10 },
    });
    const tokens = `${(130).toLocaleString()}↑${(260).toLocaleString()}`;
    expect(h.writes.at(-1)).toContain(`↓${tokens} tokens`);
  });

  it('falls back to the host label when the host never names a model', () => {
    const h = harness({ host: 'claude-work' });
    h.status.begin();
    h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 1 } });
    expect(h.writes.at(-1)).toContain('● claude-work · 0s · ↓1↑0 tokens');
  });

  it('clears the row on the result event so the summary can take it over', () => {
    const h = harness();
    h.status.begin();
    h.status.event({ kind: 'assistant', messageId: 'm1' });
    h.status.event({ kind: 'result', isError: false });
    expect(h.writes.at(-1)).toBe(`\r${ESC}[K`);
    // end() is idempotent — the caller finalizing the line as well is a no-op.
    const after = h.writes.length;
    h.status.end();
    expect(h.writes).toHaveLength(after);
  });
});

describe('RunStatusLine — the shared cursor', () => {
  it('finishes its row before the answer is written, so the two never share it', () => {
    const h = harness();
    h.status.begin();
    h.status.beforeStdout('Hello');
    expect(h.writes).toHaveLength(2);
    expect(h.writes.at(-1)).toBe('\n');
    // The row is finished now: a second write has nothing left to yield.
    h.status.beforeStdout(' world');
    expect(h.writes).toHaveLength(2);
    // 'Hello' ended no line, so the cursor is inside the answer — a carriage
    // return here would land on top of it.
    h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 5 } });
    expect(h.writes).toHaveLength(2);
  });

  it('stays off a row stdout has not finished', () => {
    const h = harness();
    h.status.begin();
    h.status.beforeStdout('unterminated');
    const afterHandover = h.writes.length;
    h.status.event({ kind: 'init', model: 'm' });
    h.status.event({ kind: 'assistant', messageId: 'm1' });
    expect(h.writes).toHaveLength(afterHandover);
    // The row is the answer's now: closing must not erase it either.
    h.status.end();
    expect(h.writes).toHaveLength(afterHandover);
  });

  it('resumes once stdout leaves the cursor at the start of a row', () => {
    const h = harness();
    h.status.begin();
    h.status.beforeStdout('Hello\n');
    // It finished its row on the way out; 'Hello\n' then left a free row behind.
    expect(h.writes.at(-1)).toBe('\n');
    h.advance(2_000);
    h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 7 } });
    expect(h.writes.at(-1)).toBe(`\r${ESC}[K● claude · 2s · ↓7↑0 tokens`);
  });

  it('treats a redirect to a file as no shared cursor at all', () => {
    const h = harness({ stdoutSharesCursor: false });
    h.status.begin();
    // The answer is not on this terminal, so nothing has to yield to it and the
    // line keeps redrawing for the whole run.
    h.status.beforeStdout('Hello');
    h.advance(1_000);
    h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 3 } });
    expect(h.writes.at(-1)).toBe(`\r${ESC}[K● claude · 1s · ↓3↑0 tokens`);
    h.status.end();
    expect(h.writes.at(-1)).toBe(`\r${ESC}[K`);
  });

  it('never emits cursor control when stderr is a pipe, whatever stdout does', () => {
    const h = harness({ stderrIsTty: false, stdoutSharesCursor: true });
    h.status.begin();
    h.status.beforeStdout('Hello');
    h.status.event({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 9 } });
    h.status.end();
    expect(h.writes).toHaveLength(2);
    expect(h.text()).not.toContain(ESC);
    expect(h.text()).not.toContain('\r');
  });
});

describe('hostStderrTail', () => {
  it('returns nothing for empty or whitespace-only stderr', () => {
    expect(hostStderrTail('')).toBe('');
    expect(hostStderrTail('\n\n  \n')).toBe('');
  });

  it('keeps short stderr whole, without the trailing newline artefact', () => {
    expect(hostStderrTail('line one\nline two\n')).toBe('line one\nline two');
  });

  it('keeps the LAST lines when the host was chatty, and says how many it dropped', () => {
    const lines = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`);
    const tail = hostStderrTail(lines.join('\n'));
    const kept = tail.split('\n');
    expect(kept[0]).toBe(`… (${35 - HOST_STDERR_TAIL_LINES} earlier lines omitted)`);
    expect(kept).toHaveLength(HOST_STDERR_TAIL_LINES + 1);
    expect(kept.at(-1)).toBe('line 35');
    expect(tail).not.toContain('line 14'); // the dropped lines are really gone
  });

  it('honors an explicit bound', () => {
    expect(hostStderrTail('a\nb\nc\n', 1)).toBe('… (2 earlier lines omitted)\nc');
  });
});

// v2 — host orchestrator core (Archetype B). Pure-function tests over the
// deterministic parts: host command resolution (default vs custom, D2a), stream
// event normalization, and the token/cost reducer with the `max usage per
// message.id` dedup rule (the detail that separates a correct cost bar from a
// ~2.5-3x over-count). No TTY, no daemon, no network, no real host spawn.

import { describe, expect, it } from 'vitest';
import {
  normalizeStreamEvent,
  parseStreamLine,
  resolveHostRun,
  UsageReducer,
} from '../src/orchestrator.js';

describe('resolveHostRun — default vs custom command (D2a)', () => {
  it('uses the host default binary when no custom command is given', () => {
    const claude = resolveHostRun('claude');
    expect(claude).not.toBeNull();
    expect(claude?.binary).toBe('claude');
    expect(claude?.flags).toContain('--output-format');
    expect(claude?.flags).toContain('stream-json');
  });

  it("pins claude's exact headless flags, partial messages included", () => {
    // Pinned deliberately. This array IS the spawn contract with the host: the
    // order is the order the flags reach its argv, and the set decides what the
    // event stream can carry. `--include-partial-messages` is what makes the
    // host report tool calls as they start and text as it is written, which is
    // the whole basis of a live run screen — dropping it silently degrades the
    // stream back to one frame per completed block, so a change here must be a
    // deliberate edit to this list.
    expect(resolveHostRun('claude')?.flags).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
  });

  it('a custom command overrides the host default binary', () => {
    const spec = resolveHostRun('claude', 'claude-work');
    expect(spec?.binary).toBe('claude-work');
  });

  it('an empty custom command falls back to the host default', () => {
    expect(resolveHostRun('claude', '')?.binary).toBe('claude');
  });

  it('agents-md has no spawnable CLI (returns null)', () => {
    expect(resolveHostRun('agents-md')).toBeNull();
  });
});

describe('parseStreamLine', () => {
  it('parses a JSON line', () => {
    expect(parseStreamLine('{"type":"result"}')).toEqual({ type: 'result' });
  });

  it('returns null for a blank line', () => {
    expect(parseStreamLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseStreamLine('{not-json')).toBeNull();
  });
});

describe('normalizeStreamEvent', () => {
  it('maps a system init event', () => {
    const e = normalizeStreamEvent({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'opus',
    });
    expect(e).toEqual({ kind: 'init', sessionId: 's1', model: 'opus' });
  });

  it('maps an assistant event with text + cumulative usage', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') {
      expect(e.messageId).toBe('m1');
      expect(e.text).toBe('hello');
      expect(e.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    }
  });

  it('maps a result event with cost + turns', () => {
    const e = normalizeStreamEvent({
      type: 'result',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.42,
      usage: { input_tokens: 400, output_tokens: 200 },
    });
    expect(e?.kind).toBe('result');
    if (e?.kind === 'result') {
      expect(e.isError).toBe(false);
      expect(e.numTurns).toBe(3);
      expect(e.totalCostUsd).toBe(0.42);
    }
  });

  it('returns null for a non-object line', () => {
    expect(normalizeStreamEvent(42)).toBeNull();
    expect(normalizeStreamEvent(null)).toBeNull();
  });

  it('names the frame it dropped on the lossy kind', () => {
    // An unmodelled frame is not silence: a consumer debugging its stream needs
    // to know which one it was without going back to the raw line.
    expect(normalizeStreamEvent({ type: 'system', subtype: 'compact_boundary' })).toEqual({
      kind: 'other',
      subtype: 'compact_boundary',
    });
    expect(normalizeStreamEvent({ type: 'api_retry' })).toEqual({
      kind: 'other',
      subtype: 'api_retry',
    });
    // An older caller that knows nothing of `subtype` still matches on kind.
    expect(normalizeStreamEvent({ type: 'nonsense' })?.kind).toBe('other');
    expect(normalizeStreamEvent({})?.kind).toBe('other');
  });
});

describe('normalizeStreamEvent — partial-message frames', () => {
  it('reports a tool call as it starts', () => {
    // The frame the host emits when a tool call begins. It carries no text and
    // no usage — its whole value is the name, which is the only thing that can
    // tell a user what the host is doing between two stretches of prose.
    const e = normalizeStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' },
      },
    });
    expect(e).toEqual({ kind: 'tool', name: 'Read' });
  });

  it('reports a slice of assistant text as it is written', () => {
    const e = normalizeStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
    });
    expect(e).toEqual({ kind: 'delta', text: 'Hel' });
  });

  it('drops the boundary frames a stream is mostly made of', () => {
    const boundary = { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
    expect(normalizeStreamEvent(boundary)).toEqual({
      kind: 'other',
      subtype: 'content_block_stop',
    });
    // A non-tool block start, and a non-text delta (thinking, input_json), are
    // not progress a run screen can show.
    expect(
      normalizeStreamEvent({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      }),
    ).toEqual({ kind: 'other', subtype: 'content_block_start' });
    expect(
      normalizeStreamEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"p' },
        },
      }),
    ).toEqual({ kind: 'other', subtype: 'content_block_delta' });
    expect(normalizeStreamEvent({ type: 'stream_event' })).toEqual({
      kind: 'other',
      subtype: 'stream_event',
    });
  });

  it('announces the tool call of a message whose whole content is a call', () => {
    // A tool-only message has no text at all. Reporting it as an assistant
    // event with no text would drop the turn on the floor; the name is the
    // event, and the message's usage rides along so the turn is still counted.
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: {
        id: 'm-tool',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep', input: { pattern: 'x' } }],
        usage: { input_tokens: 800, output_tokens: 40 },
      },
    });
    expect(e).toEqual({
      kind: 'tool',
      name: 'Grep',
      messageId: 'm-tool',
      usage: { inputTokens: 800, outputTokens: 40 },
    });
  });

  it('keeps the usage of a tool-only message in the run total', () => {
    // The one way this change could quietly corrupt the cost bar: a tool-only
    // message is often the ONLY carrier of its own message id, so its usage
    // must fold in by the same max-per-message rule as any other.
    const r = new UsageReducer();
    r.add({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 100, outputTokens: 10 } });
    r.add({
      kind: 'tool',
      name: 'Read',
      messageId: 'm2',
      usage: { inputTokens: 900, outputTokens: 60 },
    });
    r.add({
      kind: 'tool',
      name: 'Read',
      messageId: 'm2',
      usage: { inputTokens: 900, outputTokens: 90 },
    });
    expect(r.snapshot().inputTokens).toBe(1000);
    expect(r.snapshot().outputTokens).toBe(100);
  });
});

describe('UsageReducer — max usage per message.id, never sum', () => {
  it('takes the max usage across a message that emits multiple cumulative lines', () => {
    // Claude emits one JSONL line per content block of a message, each line's
    // `usage` a cumulative snapshot of that message. Summing → 300/150 (wrong);
    // max → 150/80 (correct).
    const r = new UsageReducer();
    r.add({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 100, outputTokens: 50 } });
    r.add({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 150, outputTokens: 80 } });
    expect(r.snapshot().inputTokens).toBe(150);
    expect(r.snapshot().outputTokens).toBe(80);
  });

  it('sums the per-message maxes across distinct messages', () => {
    const r = new UsageReducer();
    r.add({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 100, outputTokens: 50 } });
    r.add({ kind: 'assistant', messageId: 'm1', usage: { inputTokens: 150, outputTokens: 80 } }); // max m1 = 150/80
    r.add({ kind: 'assistant', messageId: 'm2', usage: { inputTokens: 200, outputTokens: 100 } }); // m2 = 200/100
    expect(r.snapshot().inputTokens).toBe(350);
    expect(r.snapshot().outputTokens).toBe(180);
  });

  it('records cost + turns from the result event', () => {
    const r = new UsageReducer();
    r.add({ kind: 'result', isError: false, numTurns: 4, totalCostUsd: 0.9 });
    expect(r.snapshot().totalCostUsd).toBe(0.9);
    expect(r.snapshot().numTurns).toBe(4);
  });

  it('ignores non-usage events', () => {
    const r = new UsageReducer();
    r.add({ kind: 'init', sessionId: 's1' });
    r.add({ kind: 'other' });
    expect(r.snapshot()).toEqual({ inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 0 });
  });
});

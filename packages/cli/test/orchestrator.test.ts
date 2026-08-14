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

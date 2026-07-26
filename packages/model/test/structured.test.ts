import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { runStructured } from '../src/structured.js';
import type {
  CompleteRequest,
  CompleteResult,
  CompleteSchema,
  ProviderAdapter,
} from '../src/types.js';

// Offline structured-path tests (blueprint D5 / NFR-1): a SCRIPTED fake adapter
// returns canned model outputs in sequence, so we drive the parse/validate/retry
// state machine with ZERO network. `calls` records each dispatch so assertions
// can inspect how many calls were made and what system prompt each saw (the JSON
// instruction + the corrective retry text).
interface FakeAdapter extends ProviderAdapter {
  calls: Array<{ req: CompleteRequest; key?: string }>;
}

function scriptedAdapter(responses: CompleteResult[], name = 'fake'): FakeAdapter {
  const calls: FakeAdapter['calls'] = [];
  let i = 0;
  return {
    name,
    calls,
    complete: async (req, key) => {
      calls.push({ req, key });
      // noUncheckedIndexedAccess ⇒ `responses[i]` is `CompleteResult | undefined`.
      // `undefined` means we ran past the script's end (a test bug) ⇒ synthesize a
      // structured failure. A scripted `null` is a LEGITIMATE degradation and MUST
      // pass through unchanged (so null-propagation tests are honest).
      const scripted = responses[i++];
      return scripted === undefined ? { ok: false, reason: 'script exhausted' } : scripted;
    },
  };
}

const objSchema = z.object({ title: z.string(), count: z.number() });
const objSchemaWithDesc = z
  .object({ title: z.string(), count: z.number() })
  .describe('An object with a title (string) and a count (number).');

/** A minimal valid request carrying a schema (complete() routes on its presence). */
function baseReq(schema: CompleteSchema, system?: string): CompleteRequest {
  return {
    provider: 'fake',
    model: 'm',
    prompt: 'produce JSON',
    schema,
    ...(system !== undefined ? { system } : {}),
  };
}

describe('runStructured — happy path (JSON validated on the first try)', () => {
  it('parses valid JSON and returns it as `value` (keeps raw `text` + usage)', async () => {
    const a = scriptedAdapter([{ ok: true, text: '{"title":"hi","count":3}' }]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');

    expect(a.calls).toHaveLength(1); // no retry on success.
    expect(r).toEqual({
      ok: true,
      text: '{"title":"hi","count":3}',
      value: { title: 'hi', count: 3 },
      usage: undefined, // no usage returned by the adapter here.
    });
    // The structured result carries `value`; callers branch on its presence.
    expect(r && 'value' in r && r.value).toEqual({ title: 'hi', count: 3 });
  });

  it('reports usage from the successful call', async () => {
    const a = scriptedAdapter([
      { ok: true, text: '{"title":"x","count":1}', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(r).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('validates via a function schema (not just ZodType)', async () => {
    const fnSchema: CompleteSchema = (raw) => {
      const v = raw as { n?: number };
      if (typeof v.n !== 'number') throw new Error('n must be a number');
      return { n: v.n * 2 }; // coerce: return doubled value.
    };
    const a = scriptedAdapter([{ ok: true, text: '{"n":21}' }]);
    const r = await runStructured(a, baseReq(fnSchema), 'sk');
    expect(r).toMatchObject({ ok: true, value: { n: 42 } });
  });
});

describe('runStructured — tolerant JSON extraction', () => {
  it('strips a ```json markdown fence', async () => {
    const a = scriptedAdapter([{ ok: true, text: '```json\n{"title":"a","count":1}\n```' }]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(r).toMatchObject({ ok: true, value: { title: 'a', count: 1 } });
    expect(a.calls).toHaveLength(1); // extracted cleanly — no retry spent.
  });

  it('extracts the JSON span from surrounding prose', async () => {
    const a = scriptedAdapter([
      { ok: true, text: 'Sure! Here is the result:\n{"title":"b","count":2}\nHope that helps.' },
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(r).toMatchObject({ ok: true, value: { title: 'b', count: 2 } });
    expect(a.calls).toHaveLength(1);
  });

  it('parses a top-level JSON array value', async () => {
    const arrSchema = z.array(z.string());
    const a = scriptedAdapter([{ ok: true, text: '["a","b"]' }]);
    const r = await runStructured(a, baseReq(arrSchema), 'sk');
    expect(r).toMatchObject({ ok: true, value: ['a', 'b'] });
  });
});

describe('runStructured — the single repair retry', () => {
  it('retries once on malformed JSON and succeeds on the repair', async () => {
    // A genuinely unparseable first response (no JSON anywhere) so the retry is
    // actually exercised; the repair then emits valid JSON.
    const a = scriptedAdapter([
      { ok: true, text: 'I cannot do that.' }, // no JSON anywhere ⇒ parse fail.
      { ok: true, text: '{"title":"c","count":9}' }, // repair succeeds.
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');

    expect(a.calls).toHaveLength(2); // initial + one repair.
    expect(r).toMatchObject({ ok: true, value: { title: 'c', count: 9 } });
    // value/text come from the SUCCESSFUL (second) call.
    expect(r && 'value' in r && r.value).toEqual({ title: 'c', count: 9 });
    expect(r && 'value' in r && r.text).toBe('{"title":"c","count":9}');
  });

  it('feeds the parse error back in the corrective prompt', async () => {
    const a = scriptedAdapter([
      { ok: true, text: 'no json here' },
      { ok: true, text: '{"title":"d","count":1}' },
    ]);
    await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(2);
    const retrySystem = a.calls[1]?.req.system ?? '';
    // The retry re-states the JSON contract AND surfaces the failure.
    expect(retrySystem).toContain('ONLY');
    expect(retrySystem.toLowerCase()).toContain('previous response failed validation');
  });

  it('degrades to { ok:false, reason:"schema-validation-failed" } after two bad outputs', async () => {
    const a = scriptedAdapter([
      { ok: true, text: 'nope' },
      { ok: true, text: 'still nope' },
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(2); // exactly one retry — never a third call.
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.reason).toContain('schema-validation-failed');
    }
  });

  it('retries once on a SCHEMA-VALIDATION failure (valid JSON, wrong shape)', async () => {
    // First call: valid JSON but `count` is a string ⇒ zod rejects.
    const a = scriptedAdapter([
      { ok: true, text: '{"title":"x","count":"not-a-number"}' },
      { ok: true, text: '{"title":"x","count":7}' },
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(2);
    expect(r).toMatchObject({ ok: true, value: { title: 'x', count: 7 } });
  });

  it('fails after two schema-validation failures (valid JSON, wrong shape both times)', async () => {
    const a = scriptedAdapter([
      { ok: true, text: '{"title":"x","count":"a"}' },
      { ok: true, text: '{"title":"y","count":"b"}' },
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(2);
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) expect(r.reason).toContain('schema-validation-failed');
  });
});

describe('runStructured — transport failures are NOT retried', () => {
  it('propagates an adapter { ok:false } immediately — retry budget is for JSON repair only', async () => {
    const a = scriptedAdapter([{ ok: false, reason: 'HTTP 500' }]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(1); // no retry on a transport failure.
    expect(r).toEqual({ ok: false, reason: 'HTTP 500' });
  });

  it('propagates null degradation immediately (no provider at the adapter layer)', async () => {
    const a = scriptedAdapter([null]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(1);
    expect(r).toBeNull();
  });

  it('on a repair-round transport failure, reports schema-validation-failed (the real cause)', async () => {
    // First output invalid JSON; the repair call itself fails transport ⇒ the
    // overall result is a validation failure (the JSON was never repaired), and
    // the surfaced reason is the first parse error — not the transport noise.
    const a = scriptedAdapter([
      { ok: true, text: 'not json' },
      { ok: false, reason: 'connection reset' },
    ]);
    const r = await runStructured(a, baseReq(objSchema), 'sk');
    expect(a.calls).toHaveLength(2);
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.reason).toContain('schema-validation-failed');
      expect(r.reason).not.toContain('connection reset');
    }
  });
});

describe('runStructured — prompt injection (FR-3)', () => {
  it('appends the JSON instruction to a caller-supplied system prompt', async () => {
    const a = scriptedAdapter([{ ok: true, text: '{"title":"t","count":0}' }]);
    await runStructured(a, baseReq(objSchema, 'you are a helpful assistant'), 'sk');
    const sys = a.calls[0]?.req.system ?? '';
    expect(sys).toContain('you are a helpful assistant');
    expect(sys).toMatch(/valid JSON/i);
    expect(sys).not.toMatch(/```/); // never tell it to USE fences.
  });

  it('injects a standalone JSON instruction when no system prompt is given', async () => {
    const a = scriptedAdapter([{ ok: true, text: '{"title":"t","count":0}' }]);
    await runStructured(a, baseReq(objSchema), 'sk');
    const sys = a.calls[0]?.req.system ?? '';
    expect(sys.length).toBeGreaterThan(0);
    expect(sys).toMatch(/valid JSON/i);
  });

  it('includes the schema `.description` in the instruction when present', async () => {
    const a = scriptedAdapter([{ ok: true, text: '{"title":"t","count":0}' }]);
    await runStructured(a, baseReq(objSchemaWithDesc), 'sk');
    const sys = a.calls[0]?.req.system ?? '';
    expect(sys).toContain('An object with a title (string) and a count (number).');
  });
});

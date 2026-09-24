import { describe, expect, it } from 'vitest';
import { NoirConfigSchema, parseConfig } from '../src/config.js';

/**
 * The `rules:` block. Both of its fields have live consumers: `enabled` gates
 * the working-rules seed that `noir init`/`noir create` emit and the RULES.md
 * budget check in `noir doctor`; `lengthBudgetKb` is the budget that check
 * measures `.noir/rules/RULES.md` against.
 *
 * The schema's `.describe()` strings are the single source of truth for the
 * generated configuration reference (`docs/reference/config.md`), so they are
 * user-facing text. These tests keep them describing what ships — the block
 * used to promise a rule registry with no implementation behind the switch.
 */

/** The inner object of the `rules:` block (`.default()` wraps the object, so
 *  the fields hang off the wrapped type). */
const rulesShape = NoirConfigSchema.shape.rules.def.innerType.shape;

describe('parseConfig — rules block', () => {
  it('defaults the rules block to enabled + 6KB when absent', () => {
    const cfg = parseConfig({ host: 'claude' });
    expect(cfg.rules.enabled).toBe(true);
    expect(cfg.rules.lengthBudgetKb).toBe(6);
  });

  it('round-trips an explicit rules block', () => {
    const cfg = parseConfig({
      host: 'claude',
      rules: { enabled: false, lengthBudgetKb: 12 },
    });
    expect(cfg.rules.enabled).toBe(false);
    expect(cfg.rules.lengthBudgetKb).toBe(12);
  });

  it('applies field-level defaults for a partial rules block', () => {
    const cfg = parseConfig({ host: 'claude', rules: { enabled: false } });
    expect(cfg.rules.enabled).toBe(false);
    expect(cfg.rules.lengthBudgetKb).toBe(6); // default carries
  });

  it('rejects a non-positive lengthBudgetKb', () => {
    expect(() => parseConfig({ host: 'claude', rules: { lengthBudgetKb: 0 } })).toThrow();
    expect(() => parseConfig({ host: 'claude', rules: { lengthBudgetKb: -1 } })).toThrow();
  });

  it('rejects a non-integer lengthBudgetKb', () => {
    expect(() => parseConfig({ host: 'claude', rules: { lengthBudgetKb: 1.5 } })).toThrow();
  });
});

describe('rules block — the schema text describes the shipped behaviour', () => {
  it('names no rule engine or registry: neither exists', () => {
    const block = NoirConfigSchema.shape.rules.description ?? '';
    const enabled = rulesShape.enabled.description ?? '';
    // The block used to be described as "parsed" with a consumer "shipping with
    // the rule engine", and the switch as a "rule registry master switch". A
    // reader of the generated reference would take that as a feature promise.
    for (const text of [block, enabled]) {
      expect(text).not.toMatch(/rule registry|rule engine/i);
    }
    expect(block).not.toMatch(/no consumer/i);
  });

  it('says what `enabled` gates, and what `lengthBudgetKb` measures', () => {
    const enabled = rulesShape.enabled.description ?? '';
    expect(enabled).toMatch(/seed/i);
    expect(enabled).toMatch(/doctor/i);

    // The budget applies to the whole `.noir/rules/RULES.md` file (the doctor
    // measures it end to end), not to a per-rule body — there is no such thing.
    const budget = rulesShape.lengthBudgetKb.description ?? '';
    expect(budget).toContain('RULES.md');
    expect(budget).not.toMatch(/per-rule/i);
  });
});

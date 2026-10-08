import { describe, expect, it } from 'vitest';
import { DEBT_MARKER_RULE } from '../src/debt-marker.js';
import { checkHygiene } from '../src/hygiene.js';

const flag = (line: string) => DEBT_MARKER_RULE.pattern.test(line);

describe('noir-debt marker', () => {
  it('flags a marker missing an upgrade trigger', () => {
    expect(flag('// noir-debt: global lock')).toBe(true);
  });
  it('does not flag a marker that names a trigger', () => {
    expect(flag('// noir-debt: global lock, per-account locks when throughput matters')).toBe(
      false,
    );
  });
  it('stays off ordinary prose', () => {
    expect(flag('the noir-debt ledger was full')).toBe(false);
  });
  it('flags a column-0 marker on a later line through checkHygiene', () => {
    expect(
      checkHygiene('import x;\n// noir-debt: global lock', 'code').some(
        (f) => f.id === 'noir-debt',
      ),
    ).toBe(true);
  });
});

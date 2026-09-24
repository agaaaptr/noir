// Regression tests for the human-output helpers: the definition list (a
// two-column Field/Value rendering) and the module surface that keeps dead
// helpers from coming back. The key/value helper that used to live here was
// removed because no code called it; the module-surface test pins that it stays
// gone. The definition-list tests pin that a value is formatted exactly once by
// the table, so a non-string value renders as its single string form and never
// as a double-encoded JSON string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cli-table3', () => ({
  default: class MockTable {
    private readonly rows: string[][] = [];
    constructor(public readonly opts: { head?: string[] }) {}
    push(...rows: string[][]): void {
      for (const r of rows) this.rows.push(r);
    }
    toString(): string {
      const head = this.opts.head ?? [];
      const lines = [head.join(' | ')];
      for (const r of this.rows) lines.push(r.join(' | '));
      return lines.join('\n');
    }
  },
}));

import * as output from '../src/output.js';

const { definitionList } = output;

function captureStderr(): { read: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => chunks.join(''),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

let savedStdoutTty: boolean | undefined;
beforeEach(() => {
  savedStdoutTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', {
    value: false,
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: savedStdoutTty ?? false,
    configurable: true,
    writable: true,
  });
});

describe('definitionList', () => {
  it('formats an object value as JSON exactly once (no double-encoding)', () => {
    const cap = captureStderr();
    try {
      definitionList([{ label: 'Payload', value: { a: 1 } }], {});
      const err = cap.read();
      expect(err).toContain('{"a":1}');
      // A second formatting pass over the JSON text would escape the quotes.
      expect(err).not.toContain('\\"a\\"');
    } finally {
      cap.restore();
    }
  });

  it('formats a number and a boolean through their string forms', () => {
    const cap = captureStderr();
    try {
      definitionList(
        [
          { label: 'Count', value: 3 },
          { label: 'Active', value: true },
        ],
        {},
      );
      const err = cap.read();
      expect(err).toContain('3');
      expect(err).toContain('true');
    } finally {
      cap.restore();
    }
  });

  it('renders a string value unchanged and an array as JSON', () => {
    const cap = captureStderr();
    try {
      definitionList(
        [
          { label: 'Name', value: 'noir' },
          { label: 'Items', value: [1, 2] },
        ],
        {},
      );
      const err = cap.read();
      expect(err).toContain('noir');
      expect(err).toContain('[1,2]');
    } finally {
      cap.restore();
    }
  });
});

describe('output module surface', () => {
  it('does not export the removed key/value helper', () => {
    expect('kv' in output).toBe(false);
  });
});

import {
  CONTEXT_BLOCK,
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  managedBlock,
  RULES_BLOCK,
} from '@noir-ai/core';
import { describe, expect, it } from 'vitest';

describe('managedBlock factory', () => {
  it('produces html sentinels', () => {
    const b = managedBlock('context', 'html');
    expect(b.begin).toBe('<!-- noir:context begin -->');
    expect(b.end).toBe('<!-- noir:context end -->');
    expect(b.commentStyle).toBe('html');
  });

  it('produces hash sentinels for ignore-style files', () => {
    const b = managedBlock('ignore', 'hash');
    expect(b.begin).toBe('# >>> noir:ignore >>>');
    expect(b.end).toBe('# <<< noir:ignore <<<');
  });

  it('defaults to html', () => {
    expect(managedBlock('x').commentStyle).toBe('html');
  });

  it('keeps CONTEXT_BLOCK_* byte-identical (backward compat)', () => {
    expect(CONTEXT_BLOCK_BEGIN).toBe('<!-- noir:context begin -->');
    expect(CONTEXT_BLOCK_END).toBe('<!-- noir:context end -->');
    expect(CONTEXT_BLOCK.begin).toBe(CONTEXT_BLOCK_BEGIN);
    expect(CONTEXT_BLOCK.end).toBe(CONTEXT_BLOCK_END);
  });

  it('ships a RULES_BLOCK named instance', () => {
    expect(RULES_BLOCK.begin).toBe('<!-- noir:rules begin -->');
    expect(RULES_BLOCK.end).toBe('<!-- noir:rules end -->');
  });
});

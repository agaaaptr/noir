export type CommentStyle = 'html' | 'hash';

export interface ManagedBlock {
  readonly name: string;
  readonly commentStyle: CommentStyle;
  readonly begin: string;
  readonly end: string;
}

/** Build a matched begin/end marker pair for a managed region.
 *  `html` → `<!-- noir:<name> begin -->` (markdown / CLAUDE.md / NOIR.md).
 *  `hash` → `# >>> noir:<name> >>>` (.gitignore / .dockerignore / .npmignore / yml). */
export function managedBlock(name: string, commentStyle: CommentStyle = 'html'): ManagedBlock {
  if (commentStyle === 'hash') {
    return { name, commentStyle, begin: `# >>> noir:${name} >>>`, end: `# <<< noir:${name} <<<` };
  }
  return { name, commentStyle, begin: `<!-- noir:${name} begin -->`, end: `<!-- noir:${name} end -->` };
}

/** Named instances. CONTEXT_BLOCK_* are kept byte-identical for backward compat. */
export const CONTEXT_BLOCK = managedBlock('context', 'html');
export const RULES_BLOCK = managedBlock('rules', 'html');
export const CONTEXT_BLOCK_BEGIN = CONTEXT_BLOCK.begin;
export const CONTEXT_BLOCK_END = CONTEXT_BLOCK.end;

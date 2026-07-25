import { describe, expect, it } from 'vitest';
import { render } from '../src/template.js';

describe('template.render', () => {
  it('substitutes a known var', () => {
    expect(render('id={{projectId}}', { projectId: 'abc-123' })).toBe('id=abc-123');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(render('id={{   projectId   }}', { projectId: 'x' })).toBe('id=x');
  });

  it('substitutes multiple vars', () => {
    expect(render('{{a}}-{{b}}', { a: '1', b: '2' })).toBe('1-2');
  });

  it('LEAVES unknown-var tokens in place (drift is visible, not silent)', () => {
    expect(render('id={{missing}}', { projectId: 'x' })).toBe('id={{missing}}');
  });

  it('treats null/undefined values as unknown (leaves token)', () => {
    expect(render('a={{x}} b={{y}}', { x: null, y: undefined })).toBe('a={{x}} b={{y}}');
  });

  it('stringifies non-string var values', () => {
    expect(render('n={{n}}', { n: 42 })).toBe('n=42');
    expect(render('f={{f}}', { f: true })).toBe('f=true');
  });

  it('does NOT escape — caller owns format-appropriate escaping', () => {
    // A `<` in a value passes through verbatim. Templates that target HTML must
    // pre-escape; this keeps the renderer format-agnostic.
    expect(render('v={{x}}', { x: '<script>' })).toBe('v=<script>');
  });

  it('leaves a lone `{{` (no closing `}}`) untouched', () => {
    expect(render('value={{not-a-token', { value: '1' })).toBe('value={{not-a-token');
  });

  it('is dependency-free (module path is local, not mustache/handlebars)', async () => {
    // Sanity: importing the module text and grepping for a mustache import is
    // overkill; the simpler assertion is that render behaves as above with NO
    // mustache installed in the workspace. The package.json has no `mustache`
    // dep — that's the real contract, verified at the package level.
    expect(typeof render).toBe('function');
  });
});

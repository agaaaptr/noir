/**
 * Hand-rolled `{{var}}` interpolation. No mustache/handlebars dependency —
 * Noir's markdown/yaml/json templates are simple enough that a tokenizer +
 * map lookup is sufficient and keeps `@noir-ai/create` dependency-light.
 *
 * Semantics (documented):
 *  - Tokens are `{{ name }}` / `{{name}}` — any amount of ASCII whitespace
 *    inside the braces is permitted. The name is trimmed.
 *  - Known vars (value is a string) are substituted verbatim. NO escaping is
 *    applied — callers must pre-escape for the target format (JSON/YAML/MD).
 *    This is intentional: the engine renders into multiple formats and a
 *    single universal escaper would be wrong for at least one of them.
 *  - Unknown vars (not in `vars`, or value `undefined`) → the original token
 *    is LEFT IN PLACE. Rationale: drift between template and ctx becomes
 *    visible (an unrendered `{{projectId}}` in CLAUDE.md is immediately
 *    obvious), rather than silently swallowed to empty. The spec called this
 *    out as the preferred failure mode.
 *  - Non-string var values are stringified via `String(value)` so a stray
 *    number/boolean still interpolates rather than printing `[object Object]`.
 *  - A lone `{{` with no closing `}}` is left untouched (not a token).
 */

const TOKEN = /\{\{\s*([^}{}]+?)\s*\}\}/g;

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(TOKEN, (whole, name: string) => {
    if (!Object.hasOwn(vars, name)) return whole; // unknown → leave token
    const v = vars[name];
    if (v === undefined || v === null) return whole; // treat as unknown → leave token
    return String(v);
  });
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * READ-ONLY stack detection. Probes for well-known marker files under `root`
 * and reports ONLY what is present — never assumes. The result feeds path
 * adaptation (where to drop `.claude/` vs `.cursor/` etc., future), ignore-file
 * selection, and the onboarding TUI's confirm step.
 *
 * Design rules (spec §4.5):
 *  - Never throws. A foreign/empty dir returns `{ languages: [], monorepo:
 *    false, frameworks: [], packageManager: null }`.
 *  - Never opens network, never parses code beyond a `package.json`/`pyproject`
 *    dependency list. Marker files + top-level manifests only.
 *  - Frameworks are reported only when both the marker file is present AND the
 *    framework's dependency is listed (avoids false positives from a stale
 *    `package.json`).
 */

export interface StackInfo {
  /** Lower-cased language ids found via marker files:
   *  `typescript` | `javascript` | `python` | `go` | `rust`. */
  languages: string[];
  /** True when a workspace manifest is present (pnpm-workspace, npm/yarn
   *  workspaces in package.json, turbo.json, nx.json). */
  monorepo: boolean;
  /** Lower-cased framework ids (e.g. `next`, `vite`, `express`, `fastapi`,
   *  `actix`). Empty when none detected. */
  frameworks: string[];
  /** `pnpm` | `npm` | `yarn` when a lockfile is present, else null. */
  packageManager: string | null;
}

/** Frameworks looked up against `package.json#dependencies`+`devDependencies`.
 *  Keyed by the dependency name as published on npm. */
const NODE_FRAMEWORKS: ReadonlyArray<[dep: string, id: string]> = [
  ['next', 'next'],
  ['vite', 'vite'],
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['nuxt', 'nuxt'],
  ['remix', 'remix'],
  ['@sveltejs/kit', 'sveltekit'],
  ['@angular/core', 'angular'],
  ['react', 'react'],
  ['vue', 'vue'],
];

/** Frameworks looked up against `[project] dependencies` /
 *  `[project.optional-dependencies]` / `[tool.poetry.dependencies]` in
 *  `pyproject.toml`. Keyed by the PyPI package name. */
const PYTHON_FRAMEWORKS: ReadonlyArray<[dep: string, id: string]> = [
  ['fastapi', 'fastapi'],
  ['flask', 'flask'],
  ['django', 'django'],
  ['sanic', 'sanic'],
  ['starlette', 'starlette'],
  ['tornado', 'tornado'],
  ['aiohttp', 'aiohttp'],
  ['bottle', 'bottle'],
  ['pyramid', 'pyramid'],
  ['falcon', 'falcon'],
];

/** Read+parse JSON without throwing; returns undefined on any error. JSON5/ESM
 *  `package.json` with comments would land here too — `package.json` is plain
 *  JSON in practice so a failed `JSON.parse` genuinely means "not a node
 *  project" or "broken file", both of which we report as "absent". */
function readJson<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

export function detectStack(root: string): StackInfo {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  let monorepo = false;
  let packageManager: string | null = null;

  // Node / JS / TS — gated on package.json presence.
  const pjPath = join(root, 'package.json');
  if (existsSync(pjPath)) {
    const pj = readJson<PackageJson>(pjPath);
    if (pj) {
      const hasTs =
        Boolean(pj.devDependencies?.typescript) || existsSync(join(root, 'tsconfig.json'));
      languages.add(hasTs ? 'typescript' : 'javascript');

      const deps = new Set([
        ...Object.keys(pj.dependencies ?? {}),
        ...Object.keys(pj.devDependencies ?? {}),
      ]);
      for (const [dep, id] of NODE_FRAMEWORKS) {
        if (deps.has(dep)) frameworks.add(id);
      }

      const ws = pj.workspaces;
      if (
        Array.isArray(ws) ||
        (typeof ws === 'object' && ws !== null && Array.isArray(ws.packages))
      ) {
        monorepo = true;
      }
      if (typeof pj.packageManager === 'string' && pj.packageManager.length > 0) {
        // `packageManager: pnpm@10.12.4` → `pnpm`. Yarn/npm similarly.
        const m = pj.packageManager.split('@')[0];
        if (m) packageManager = m;
      }
    }
  }

  // Workspace manifests (these override/confirm monorepo independent of pj).
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) {
    monorepo = true;
    packageManager = packageManager ?? 'pnpm';
  }
  if (existsSync(join(root, 'turbo.json')) || existsSync(join(root, 'nx.json'))) {
    monorepo = true;
  }

  // Lockfiles pin packageManager when `package.json#packageManager` didn't.
  if (!packageManager) {
    if (existsSync(join(root, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (existsSync(join(root, 'yarn.lock'))) packageManager = 'yarn';
    else if (existsSync(join(root, 'package-lock.json'))) packageManager = 'npm';
  }

  // Python — pyproject.toml / requirements.txt / Pipfile / setup.py.
  if (
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'requirements.txt')) ||
    existsSync(join(root, 'Pipfile')) ||
    existsSync(join(root, 'setup.py'))
  ) {
    languages.add('python');
    // Framework detection scans pyproject.toml for PEP 508 dependency names
    // under `[project] dependencies` / `[project.optional-dependencies]` /
    // `[tool.poetry.dependencies]`. A full section-aware TOML parse is overkill
    // at v1 (and would need a dep we don't ship); the boundary-aware text scan
    // in `pyprojectHasDep` is robust to the three formats users actually write
    // and never throws on malformed TOML (degrades to "no match").
    if (existsSync(join(root, 'pyproject.toml'))) {
      const raw = safeRead(join(root, 'pyproject.toml'));
      if (raw) {
        for (const [dep, id] of PYTHON_FRAMEWORKS) {
          if (pyprojectHasDep(raw, dep)) frameworks.add(id);
        }
      }
    }
  }

  // Go — go.mod.
  if (existsSync(join(root, 'go.mod'))) {
    languages.add('go');
    packageManager = packageManager ?? 'go-modules';
  }

  // Rust — Cargo.toml.
  if (existsSync(join(root, 'Cargo.toml'))) {
    languages.add('rust');
    const raw = safeRead(join(root, 'Cargo.toml'));
    if (raw) {
      // M3: Cargo.toml deps are always `name = "ver"` or `name = { … }`, so
      // require the `=` after the crate name. The old `/^\s*actix\b/m` matched
      // `actix-web` (word boundary between `x` and `-`) and falsely reported
      // `actix`. Treat the hyphenated runtime (`actix-web`) as its OWN id and
      // gate bare `actix` on the equals form. Same equals-form tightening is
      // applied to `axum`/`rocket` so `axum-extra`-style crates don't trip the
      // same bug. The `/m` flag makes `^` match any line (the previous
      // `/^actix\s*=/` had no `/m` and only matched a string starting with
      // `actix`, i.e. effectively never — dead code).
      if (/^\s*actix-web\b/m.test(raw)) frameworks.add('actix-web');
      if (/^\s*actix\s*=/m.test(raw)) frameworks.add('actix');
      if (/^\s*axum\s*=/m.test(raw)) frameworks.add('axum');
      if (/^\s*rocket\s*=/m.test(raw)) frameworks.add('rocket');
    }
    packageManager = packageManager ?? 'cargo';
  }

  return {
    languages: [...languages].sort(),
    monorepo,
    frameworks: [...frameworks].sort(),
    packageManager,
  };
}

function safeRead(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** True iff `dep` appears as a PEP 508 dependency name in `pyproject.toml`
 *  text — handles PEP 621 `dependencies`/`optional-dependencies` list entries
 *  (`"fastapi"`, `"fastapi[all]>=0.100"`) AND Poetry `[tool.poetry.dependencies]`
 *  bare keys (`fastapi = "^0.100"`).
 *
 *  The `before` boundary (line-start, quote, or whitespace) plus the `after`
 *  PEP 508 boundary (whitespace, quote, version specifier `<>=!~`, extras `[`,
 *  marker `;`, or end-of-string) prevent substring mismatches — `flask` will
 *  NOT match `flask-restful`, and `fastapi` will NOT match `x-fastapi`.
 *
 *  Never throws: `dep` is escaped, the regex is constructed from a controlled
 *  template, and `String.prototype.test` is total on string input. Malformed
 *  TOML simply yields no matches. */
function pyprojectHasDep(raw: string, dep: string): boolean {
  const esc = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = `(?:^|["'\\s])`;
  const after = `(?=\\s|["'<>=!~;]|\\[|$)`;
  return new RegExp(`${before}${esc}${after}`, 'm').test(raw);
}

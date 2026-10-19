import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StackInfo } from './stack-detect.js';

/**
 * Project-baseline compilation: the derivable facts (`detectStack`'s stack
 * summary plus canonical commands and entry points) rendered into the short
 * markdown block the host's `@import`ed `.noir/NOIR.md` carries. Read-only and
 * total: a foreign or empty dir still renders a minimal "unknown" block, never
 * throws.
 */

/** package.json script keys we surface as canonical commands. */
const COMMAND_KEYS: ReadonlyArray<[name: string, key: string]> = [
  ['build', 'build'],
  ['test', 'test'],
  ['lint', 'lint'],
  ['typecheck', 'typecheck'],
  ['format', 'format'],
  ['start', 'start'],
  ['dev', 'dev'],
];

/** Well-known entry-point files probed at the project root only. */
const ENTRY_POINTS: ReadonlyArray<string> = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.jsx',
  'src/main.ts',
  'src/main.js',
  'src/main.py',
  'main.ts',
  'main.js',
  'main.py',
  'app/main.py',
  'src/app.py',
  'cmd/main.go',
  'src/lib.rs',
  'src/main.rs',
];

/** Canonical commands found in package.json scripts (plus Makefile targets). */
export function detectCommands(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pjPath = join(root, 'package.json');
  if (existsSync(pjPath)) {
    let pj: { scripts?: Record<string, string> } | undefined;
    try {
      pj = JSON.parse(readFileSync(pjPath, 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      pj = undefined;
    }
    for (const [name, key] of COMMAND_KEYS) {
      const value = pj?.scripts?.[key];
      if (typeof value === 'string' && value !== '') out[name] = value;
    }
  }
  const makefile = join(root, 'Makefile');
  if (existsSync(makefile)) {
    try {
      const raw = readFileSync(makefile, 'utf8');
      for (const name of ['build', 'test', 'lint']) {
        if (!(name in out) && new RegExp(`^${name}:`, 'm').test(raw)) out[name] = `make ${name}`;
      }
    } catch {
      // unreadable Makefile: skip
    }
  }
  return out;
}

/** Entry-point files found at the project root. */
export function detectEntryPoints(root: string): string[] {
  return ENTRY_POINTS.filter((p) => existsSync(join(root, p)));
}

/** Render the short baseline block, always at least one line. */
export function renderBaseline(
  stack: StackInfo,
  commands: Record<string, string>,
  entryPoints: string[],
): string {
  const lang = stack.languages.length > 0 ? stack.languages.join(', ') : 'unknown';
  const framework = stack.frameworks.length > 0 ? ` (${stack.frameworks.join(', ')})` : '';
  const lines = [
    `- **Stack:** ${lang}${framework}${stack.monorepo ? ' (monorepo)' : ''}`,
    `- **Package manager:** ${stack.packageManager ?? 'none'}`,
  ];
  if (stack.ci) lines.push(`- **CI:** ${stack.ci}`);
  const entries = Object.entries(commands);
  if (entries.length > 0) {
    lines.push('- **Commands:**');
    for (const [name, command] of entries) lines.push(`  - \`${name}\`: \`${command}\``);
  }
  if (entryPoints.length > 0) lines.push(`- **Entry points:** ${entryPoints.join(', ')}`);
  return lines.join('\n');
}

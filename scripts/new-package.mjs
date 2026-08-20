#!/usr/bin/env node
// Scaffolds a new @noir-ai/* package in the monorepo, following the established
// publish-ready template (package.json with all publish fields + tsup + tsconfig +
// src barrel + README + a smoke test), AND wires the one manual papercut — the
// vitest.config.ts source-alias for the new package.
//
// Unified versioning: the new package inherits the current version from
// packages/core/package.json, so it releases in lockstep with the other 10.
//
// Usage:
//   node scripts/new-package.mjs <name>      # e.g. node scripts/new-package.mjs telemetry
//
// Then: pnpm install && pnpm build && pnpm test, and fill in src/ + README +
// package.json description/deps. The new package is automatically included in
// unified versioning (scripts/bump-version.mjs) and the release.yml publish.
//
// Exits non-zero on a missing/invalid name or if packages/<name> already exists.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PACKAGES = join(ROOT, 'packages');

const name = process.argv[2];
if (!name) {
  console.error('Usage: node scripts/new-package.mjs <name>   (e.g. telemetry)');
  process.exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`Error: "${name}" must be kebab-case (lowercase letters/digits/hyphens).`);
  process.exit(1);
}
const pkgDir = join(PACKAGES, name);
if (existsSync(pkgDir)) {
  console.error(`Error: packages/${name} already exists.`);
  process.exit(1);
}

// Unified version: inherit from an existing package (core is the foundation).
const corePkg = JSON.parse(await readFile(join(PACKAGES, 'core', 'package.json'), 'utf8'));
const version = corePkg.version;

await mkdir(join(pkgDir, 'src'), { recursive: true });
await mkdir(join(pkgDir, 'test'), { recursive: true });

const pkgJson = {
  name: `@noir-ai/${name}`,
  version,
  description: `Noir ${name} — TODO: one-line role for this package.`,
  license: 'MIT',
  author: 'agaaaptr',
  homepage: 'https://github.com/agaaaptr/noir#readme',
  repository: {
    type: 'git',
    url: 'https://github.com/agaaaptr/noir.git',
    directory: `packages/${name}`,
  },
  bugs: { url: 'https://github.com/agaaaptr/noir/issues' },
  keywords: ['noir', name],
  engines: { node: '>=22' },
  publishConfig: { access: 'public', provenance: true },
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
  files: ['dist', 'README.md'],
  scripts: { build: 'tsup', typecheck: 'tsc --noEmit' },
  // Default: every package depends on core (types/config/layout). Add more as needed.
  dependencies: { '@noir-ai/core': 'workspace:*' },
  devDependencies: { '@types/node': '^22.17.0' },
};
await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');

await writeFile(
  join(pkgDir, 'tsup.config.ts'),
  "import { defineConfig } from 'tsup';\n\nexport default defineConfig({\n  entry: ['src/index.ts'],\n  format: ['esm'],\n  dts: true,\n  clean: true,\n  sourcemap: true,\n});\n",
  'utf8',
);

await writeFile(
  join(pkgDir, 'tsconfig.json'),
  '{\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": {\n    "outDir": "dist",\n    "rootDir": "src"\n  },\n  "include": ["src"]\n}\n',
  'utf8',
);

await writeFile(
  join(pkgDir, 'src', 'index.ts'),
  `// @noir-ai/${name} — TODO: implement. Barrel-export the package's public API.\n\nexport {};\n`,
  'utf8',
);

await writeFile(
  join(pkgDir, 'README.md'),
  `# @noir-ai/${name}\n\n> TODO: one-line role for this package.\n\nPart of the **[Noir](https://github.com/agaaaptr/noir#readme)** toolkit.\n\n## Install\n\n\`\`\`bash\nnpm install @noir-ai/${name}\n\`\`\`\n\nMost users install the CLI instead: \`npm install -g @noir-ai/cli\`.\n\n## License\n\nMIT\n`,
  'utf8',
);

await writeFile(
  join(pkgDir, 'test', 'smoke.test.ts'),
  `import { describe, expect, it } from 'vitest';\n\ndescribe('@noir-ai/${name}', () => {\n  it('loads', () => {\n    expect(true).toBe(true);\n  });\n});\n`,
  'utf8',
);

// Wire the vitest source-alias (the one manual papercut — automated here).
const vcPath = join(ROOT, 'vitest.config.ts');
const vc = await readFile(vcPath, 'utf8');
const aliasLine = `      '@noir-ai/${name}': alias('${name}'),`;
if (vc.includes(`'@noir-ai/${name}'`)) {
  console.log(`vitest alias for @noir-ai/${name} already present (skipped).`);
} else {
  const lines = vc.split('\n');
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*'@noir-ai\//.test(lines[i] ?? '')) lastIdx = i;
  }
  if (lastIdx < 0) {
    throw new Error('vitest.config.ts has no @noir-ai alias to anchor after — add it manually.');
  }
  lines.splice(lastIdx + 1, 0, aliasLine);
  await writeFile(vcPath, lines.join('\n'), 'utf8');
  console.log(`Added vitest alias for @noir-ai/${name}.`);
}

console.log(`\nCreated packages/${name}/ (@noir-ai/${name} v${version}).`);
console.log('Next: pnpm install && pnpm build && pnpm test');
console.log(
  'Then: fill in src/index.ts, the README role, package.json description/deps, and your tests.',
);
console.log(
  'Publish: automatically included in unified versioning (bump-version.mjs) + the release.yml publish.',
);

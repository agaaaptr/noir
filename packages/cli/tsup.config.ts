import { defineConfig } from 'tsup';

// Two-config build. The split is what keeps the lazy `tui` (React/Ink) graph
// OUT of the main CLI build while keeping dist/bin.js a real entry with the
// `isMainModule` realpath guard inline (a global `noir` install under its
// npm symlink silently exits 0 if that guard is ever hoisted into a chunk).
//
//   1. Main CLI (bin + index): esbuild sees `await import(tuiUrl)` where
//      `tuiUrl` is a runtime expression, so it CANNOT statically follow the
//      import into the tui graph. bin.ts's entry body therefore stays inline
//      in dist/bin.js. React/Ink never enter this graph at all.
//   2. TUI dashboard: built as a sibling entry to dist/tui/index.js so the
//      runtime `new URL('./tui/index.js', import.meta.url)` resolves. React
//      and Ink are external (resolved from node_modules at runtime).
//
// `clean: true` only on the first config; the second writes into the already-
// clean dist without wiping it (tsup runs array configs in order).
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/bin.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/tui/index.tsx'],
    outDir: 'dist/tui',
    format: ['esm'],
    dts: false,
    sourcemap: true,
    // React + Ink are resolved from node_modules at runtime (the CLI's
    // package.json declares them as dependencies, so a global `npm i -g` lays
    // them down next to dist/). External keeps the dashboard chunk tiny.
    external: ['react', 'react/jsx-runtime', 'ink'],
  },
]);

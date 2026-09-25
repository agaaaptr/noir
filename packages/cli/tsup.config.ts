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
// The output-hygiene scan (src/hygiene-scan.ts) is NOT in this array: it is
// built by a SEPARATE tsup invocation (tsup.hygiene.config.ts, chained after
// this one by the package's `build` script). tsup runs array configs in
// PARALLEL, and config 1's `clean: true` wipes the shared dist/ — its d.ts
// build deletes every `*.d.ts` in it — so a hygiene-scan entry here would race
// that clean and lose its `dist/hygiene-scan.d.ts`, breaking the published
// `./hygiene-scan` subpath export. Running the scan after the clean, in its own
// invocation, is what keeps both `dist/hygiene-scan.js` and its d.ts present.
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/bin.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    // `splitting: false` is the INVARIANT behind the guard note above: tsup's
    // default ESM code-splitting hoists shared modules (including bin.ts's
    // `isMainModule` guard + `run()` entry body) into a `chunk-*.js` file. In
    // that chunk `import.meta.url` points at the CHUNK, not the invoked
    // `dist/bin.js`, so the realpath(argv[1]) === import.meta.url comparison
    // fails and a global `noir` install silently exits 0 (main() never runs).
    // Disabling splitting keeps bin.ts's entry body inline in dist/bin.js.
    splitting: false,
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

import { defineConfig } from 'tsup';

// The output-hygiene scan, built as its own entry so the CI gate
// (scripts/hygiene-gate.mjs) can import it without pulling the whole CLI
// graph (commander, the daemon, the model layer). It keeps only
// `@noir-ai/skills` as a runtime dependency, so the gate never loads a native
// binding. No banner: this is an imported module, not an executable.
//
// Built by a SEPARATE tsup invocation (see the package's `build` script), which
// runs AFTER the main + tui config in tsup.config.ts. That config's `clean: true`
// wipes the shared dist/ — its d.ts build deletes every `*.d.ts` in it — and
// tsup runs array configs in parallel, so a hygiene-scan entry inside that array
// would race the clean and lose its `dist/hygiene-scan.d.ts`. Running it after
// the clean, here, keeps both `dist/hygiene-scan.js` and its d.ts in the tarball
// the `./hygiene-scan` subpath export promises. No `clean` here: this invocation
// must add files, never remove the main build's output.
export default defineConfig({
  entry: ['src/hygiene-scan.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  splitting: false,
});

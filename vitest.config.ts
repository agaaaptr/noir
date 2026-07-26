import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const alias = (pkg: string) =>
  fileURLToPath(new URL(`packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@noir-ai/core': alias('core'),
      '@noir-ai/daemon': alias('daemon'),
      '@noir-ai/adapters': alias('adapters'),
      '@noir-ai/cli': alias('cli'),
      '@noir-ai/store': alias('store'),
      '@noir-ai/workflow': alias('workflow'),
      // @noir-ai/context is consumed at runtime by the daemon's context-seam
      // (a VALUE import of `ContextEngine`, not type-only), so daemon tests that
      // touch the seam must resolve it to SOURCE like every other workspace
      // package — without this the round-trip test needs a built dist.
      '@noir-ai/context': alias('context'),
      // @noir-ai/memory + @noir-ai/model are likewise VALUE-imported by the
      // daemon's memory-seam (`createMemoryEngine` + `complete`/
      // `resolveModelConfig`), so daemon tests that touch the memory tools must
      // resolve them to SOURCE too (mirrors the context alias above).
      '@noir-ai/memory': alias('memory'),
      '@noir-ai/model': alias('model'),
    },
  },
  test: {
    include: [`${root}packages/*/test/**/*.test.ts`, `${root}packages/*/test/**/*.test.tsx`],
    testTimeout: 15000,
  },
});

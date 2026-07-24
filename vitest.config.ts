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
    },
  },
  test: {
    include: [`${root}packages/*/test/**/*.test.ts`],
    testTimeout: 15000,
  },
});

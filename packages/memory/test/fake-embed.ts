// Local deterministic 384-dim embedder for the offline memory suite.
//
// `fakeEmbedFn` in @noir-ai/context is TEST-ONLY and NOT exported from that
// package's public barrel (its `exports` map ships only `.`), so the memory
// suite keeps its own byte-identical copy rather than importing a test fixture
// from a published package. Same contract: same text → same unit-norm vector,
// different text → different direction, no RNG/clock.
import { createHash } from 'node:crypto';
import type { EmbedFn } from '@noir-ai/context';

export function fakeEmbedFn(dim = 384): EmbedFn {
  return (text: string): Promise<Float32Array> => {
    const hash = createHash('sha256').update(text, 'utf8').digest();
    const raw = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      const byte = hash[i % hash.length];
      if (byte !== undefined) raw[i] = (byte - 128) / 128;
    }
    // L2-normalize (matches the context fake).
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) raw[i] /= norm;
    return Promise.resolve(raw);
  };
}

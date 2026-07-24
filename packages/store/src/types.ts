import type { ProjectId } from '@noir-ai/core';

export interface OpenOptions {
  projectId: ProjectId;
  root: string;
  readonly?: boolean;
}

export interface FtsHit {
  id: string;
  source: string;
  score: number;
  snippet: string;
  meta?: unknown;
}

export interface VecHit {
  id: string;
  source: string;
  score: number;
  meta?: unknown;
}

export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface Store {
  readonly projectId: ProjectId;
  close(): Promise<void>;
}

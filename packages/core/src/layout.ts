import { join } from 'node:path';

export const NOIR_DIR = '.noir';

export const paths = {
  noirDir: (root: string) => join(root, NOIR_DIR),
  noirMd: (root: string) => join(root, NOIR_DIR, 'NOIR.md'),
  config: (root: string) => join(root, NOIR_DIR, 'config.yml'),
  projectId: (root: string) => join(root, NOIR_DIR, 'project.id'),
} as const;

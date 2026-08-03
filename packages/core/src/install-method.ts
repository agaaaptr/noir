import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { noirHome } from './layout.js';

export type InstallMethod =
  | 'native'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'homebrew'
  | 'scoop'
  | 'unknown';

export interface InstallRecord {
  method: InstallMethod;
  version: string;
  channel: string;
  installedAt: string;
  managedRuntimeVersion?: string;
}

export function installJsonPath(): string {
  return process.env.NOIR_INSTALL_JSON ?? join(noirHome(), 'install.json');
}

/** Write a file atomically: write to a temp sibling, fsync, then rename. Never
 *  in-place overwrite (macOS code-sign inode-taint → SIGKILL; Windows locks). */
export function atomicWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

export function writeInstallRecord(rec: InstallRecord): void {
  atomicWriteFile(installJsonPath(), `${JSON.stringify(rec, null, 2)}\n`);
}

export function readInstallRecord(): InstallRecord | null {
  try {
    const raw = readFileSync(installJsonPath(), 'utf8');
    const rec = JSON.parse(raw) as InstallRecord;
    if (typeof rec.method === 'string' && typeof rec.version === 'string') return rec;
    return null;
  } catch {
    return null;
  }
}

export function clearInstallRecord(): void {
  const p = installJsonPath();
  if (existsSync(p)) rmSync(p, { force: true });
}

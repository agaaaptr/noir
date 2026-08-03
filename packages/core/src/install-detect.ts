import { spawn } from 'node:child_process';
import { type InstallMethod, readInstallRecord } from './install-method.js';

export interface DetectResult {
  method: InstallMethod;
  version: string | null;
  uninstallCmd: string | null;
  managerDetected: boolean;
}

const UNINSTALL: Record<Exclude<InstallMethod, 'native' | 'unknown'>, string> = {
  npm: 'npm uninstall -g @noir-ai/cli',
  pnpm: 'pnpm remove -g @noir-ai/cli',
  yarn: 'yarn global remove @noir-ai/cli',
  bun: 'bun rm -g @noir-ai/cli',
  homebrew: 'brew uninstall noir',
  scoop: 'scoop uninstall noir',
};

export function uninstallCommandFor(method: InstallMethod): string | null {
  if (method === 'native' || method === 'unknown') return null;
  return UNINSTALL[method];
}

export function detectActiveMethod(): InstallMethod {
  return readInstallRecord()?.method ?? 'unknown';
}

/** Read-only detection of every noir install on the system. Never mutates. */
export async function detectInstallMethods(env: NodeJS.ProcessEnv): Promise<DetectResult[]> {
  const results: DetectResult[] = [];
  // npm global
  try {
    const { code, stdout } = await runManagerCmd(['npm', 'ls', '-g', '@noir-ai/cli', '--depth=0'], {
      env,
    });
    if (code === 0 || stdout.includes('@noir-ai/cli')) {
      results.push({
        method: 'npm',
        version: null,
        uninstallCmd: UNINSTALL.npm,
        managerDetected: true,
      });
    }
  } catch {
    /* not installed */
  }
  // pnpm
  try {
    const { code, stdout } = await runManagerCmd(['pnpm', 'list', '-g', '@noir-ai/cli'], { env });
    if (code === 0 || stdout.includes('@noir-ai/cli')) {
      results.push({
        method: 'pnpm',
        version: null,
        uninstallCmd: UNINSTALL.pnpm,
        managerDetected: true,
      });
    }
  } catch {
    /* not installed */
  }
  // yarn classic
  try {
    const { code, stdout } = await runManagerCmd(['yarn', 'global', 'list'], { env });
    if (code === 0 && stdout.includes('@noir-ai/cli')) {
      results.push({
        method: 'yarn',
        version: null,
        uninstallCmd: UNINSTALL.yarn,
        managerDetected: true,
      });
    }
  } catch {
    /* not installed */
  }
  // bun
  try {
    const { code, stdout } = await runManagerCmd(['bun', 'pm', 'ls', '-g'], { env });
    if (code === 0 && stdout.includes('@noir-ai/cli')) {
      results.push({
        method: 'bun',
        version: null,
        uninstallCmd: UNINSTALL.bun,
        managerDetected: true,
      });
    }
  } catch {
    /* not installed */
  }
  // homebrew
  try {
    const { code, stdout } = await runManagerCmd(['brew', 'list', '--versions', 'noir'], { env });
    if (code === 0 || stdout.toLowerCase().includes('noir')) {
      results.push({
        method: 'homebrew',
        version: null,
        uninstallCmd: UNINSTALL.homebrew,
        managerDetected: true,
      });
    }
  } catch {
    /* not installed */
  }
  // scoop
  try {
    const { code, stdout } = await runManagerCmd(['scoop', 'which', 'noir'], { env });
    if (code === 0 || stdout.toLowerCase().includes('noir')) {
      results.push({
        method: 'scoop',
        version: null,
        uninstallCmd: UNINSTALL.scoop,
        managerDetected: true,
      });
    }
  } catch {
    /* not installed */
  }
  return results;
}

/** Run a manager subprocess with a timeout. Never throws: non-zero → {code,stdout,stderr}. */
export function runManagerCmd(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // stdin ignored (managers never read from stdin), stdout/stderr piped.
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
    const command = cmd[0];
    if (command === undefined) {
      resolve({ code: -1, stdout: '', stderr: 'empty command' });
      return;
    }
    const child = spawn(command, cmd.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: 'timeout' });
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

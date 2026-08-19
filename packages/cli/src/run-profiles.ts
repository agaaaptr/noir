// Run profiles (D2c → `run.profiles` in .noir/config.yml): named host-binary
// bundles selected by `--profile` / NOIR_PROFILE / run.defaultProfile, modeled
// on the ssh_config / VS-Code-terminal-profiles precedent. Selection precedence
// is the universal ladder: explicit flag > env var > persisted config default >
// built-in default. An explicitly named profile that does not exist is a hard
// error that lists the available names (botocore semantics + inline listing).
//
// Security doctrine: `env` values may reference `${VAR}` from Noir's process
// environment and `null` deletes a variable from the child env — .noir/config.yml
// is committable project state, so literal secrets must never be stored there.

import type { NoirConfig } from '@noir-ai/core';
import { loadProjectInfo } from '@noir-ai/core';

export interface ProfileResolution {
  readonly binary?: string;
  readonly env?: Record<string, string | undefined>;
  readonly args?: readonly string[];
  readonly profileName?: string;
}

export type ProfileResolutionResult =
  | { readonly ok: true; readonly profile: ProfileResolution }
  | { readonly ok: false; readonly message: string };

/** Best-effort project config load — `noir run` keeps working outside a project. */
export function loadRunConfig(root: string): NoirConfig | null {
  try {
    return loadProjectInfo(root).config;
  } catch {
    return null;
  }
}

/** Expand `${NAME}` references from `env`; unresolved references stay literal. */
export function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    env[name] !== undefined ? (env[name] as string) : match,
  );
}

/**
 * Resolve the effective profile. `requested` is the `--profile` flag value.
 * Precedence: requested > NOIR_PROFILE env > run.defaultProfile > none.
 */
export function resolveRunProfile(
  requested: string | undefined,
  config: NoirConfig,
  env: Record<string, string | undefined>,
): ProfileResolutionResult {
  const profiles = config.run?.profiles ?? {};
  const names = Object.keys(profiles);
  const name = requested ?? env.NOIR_PROFILE ?? config.run?.defaultProfile;
  if (name === undefined || name.length === 0) {
    return { ok: true, profile: {} }; // built-in host default, unchanged
  }
  const profile = profiles[name];
  if (!profile) {
    const available =
      names.length > 0
        ? names.join(', ')
        : '(none defined — add a run.profiles block to .noir/config.yml)';
    return {
      ok: false,
      message: `unknown run profile "${name}" — no profile named "${name}" is defined under run.profiles in .noir/config.yml. Available: ${available}`,
    };
  }
  const envExpanded: Record<string, string | undefined> = {};
  if (profile.env) {
    for (const [k, v] of Object.entries(profile.env)) {
      envExpanded[k] = v === null ? undefined : expandEnvVars(v, env);
    }
  }
  return {
    ok: true,
    profile: { binary: profile.binary, env: envExpanded, args: profile.args, profileName: name },
  };
}

/** Rows for `noir run --list-profiles`. Keys match the table() column labels. */
export function listProfiles(
  config: NoirConfig,
): Array<{ NAME: string; DEFAULT: string; BINARY: string }> {
  const profiles = config.run?.profiles ?? {};
  const def = config.run?.defaultProfile;
  return Object.keys(profiles).map((name) => ({
    NAME: name,
    DEFAULT: name === def ? '*' : '',
    BINARY: profiles[name]?.binary ?? '',
  }));
}

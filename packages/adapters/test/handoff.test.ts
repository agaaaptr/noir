// Host handoff directive helpers + the optional `emitHandoff` adapter hook.
// Pins:
//   • `hostLaunchDirective(host)` returns host-correct text for EVERY
//     SUPPORTED_HOSTS member (the single source shared by the home banner + the
//     handoff artifact);
//   • `HostAdapter.emitHandoff` is OPTIONAL — a minimal stub adapter
//     type-checks + runs without implementing it (back-compat proof);
//   • `defaultHandoffBlock` composes the generic directive (the fallback the CLI
//     uses when a host does not override).
import { describe, expect, it } from 'vitest';
import {
  defaultHandoffBlock,
  hostLaunchDirective,
  resolveAdapter,
  SUPPORTED_HOSTS,
} from '../src/index.js';
import type { EmitContext, HandoffPayload, HostAdapter, HostId } from '../src/types.js';

describe('hostLaunchDirective — the single source for the host-launch line', () => {
  it('returns host-correct text for each SUPPORTED_HOSTS member', () => {
    for (const host of SUPPORTED_HOSTS) {
      const line = hostLaunchDirective(host);
      // Names the host (the "Open `<host>`" portion).
      expect(line).toContain(`Open \`${host}\``);
      // Lists the OTHER hosts (so a multi-host user knows their options).
      for (const other of SUPPORTED_HOSTS) {
        if (other === host) continue;
        expect(line).toContain(other);
      }
      // Doctrine: text only — never a spawn / shell token.
      expect(line).not.toContain('exec');
      expect(line).not.toContain('spawn');
    }
  });

  it('is the generic, host-agnostic directive (no per-host tailoring here)', () => {
    const line = hostLaunchDirective('claude');
    // The wording is the shared baseline — per-host tailoring lives on the
    // adapter's `emitHandoff` hook, not in this single-line helper.
    expect(line).toContain('Noir set the rules, skills, and memory');
    expect(line).toContain('runs the code');
  });

  it('lists claude first in the "other hosts" tail when host !== claude', () => {
    const line = hostLaunchDirective('cursor');
    const tail = line.slice(line.indexOf('other hosts:'));
    // claude appears in the tail (it's an "other" for the cursor host).
    expect(tail).toContain('claude');
    // The host token appears only in the leading "→ host: cursor." portion.
    expect(line.startsWith('→ host: cursor.')).toBe(true);
  });
});

describe('HostAdapter.emitHandoff — optional hook (back-compat proof)', () => {
  it('a minimal stub adapter (no emitHandoff) type-checks and runs', () => {
    // The back-compat contract: existing / third-party adapters that don't
    // implement `emitHandoff` continue to work. The CLI falls back to
    // `defaultHandoffBlock` when the hook is absent.
    const stub: HostAdapter = {
      id: 'claude',
      emitMcpConfig: () => '{}',
      emitContext: () => '',
      // No emitHandoff, no emitRules, no skillsDir — all optional seams absent.
    };
    expect(stub.id).toBe('claude');
    expect(typeof stub.emitHandoff).toBe('undefined');
  });

  it('every shipped adapter may omit emitHandoff (resolveAdapter returns adapters without it)', () => {
    // None of the five shipped adapters implement emitHandoff today (the generic
    // default is the right call for all of them). This pins that the optional
    // hook is truly optional — the registry resolves cleanly without it.
    for (const host of SUPPORTED_HOSTS) {
      const adapter = resolveAdapter(host);
      // emitHandoff is optional; today none implement it.
      expect(adapter.emitHandoff).toBeUndefined();
    }
  });

  it('a host CAN implement emitHandoff to tailor the directive block', () => {
    const ctx: EmitContext = { root: '/tmp/demo' };
    const payload: HandoffPayload = {
      project: { id: 'p', name: 'demo' },
      host: 'claude',
      task: { taskId: 't-1', phase: 'plan', nextGate: 'execute', nextSkill: 'noir-executing-plans' },
    };
    const tailored: HostAdapter = {
      id: 'claude',
      emitMcpConfig: () => '{}',
      emitContext: () => '',
      emitHandoff: (_c, p) => `Tailored for ${p.host}: open CLAUDE.md and read .claude/skills/.`,
    };
    expect(typeof tailored.emitHandoff).toBe('function');
    expect(tailored.emitHandoff?.(ctx, payload)).toContain('Tailored for claude');
  });
});

describe('defaultHandoffBlock — the generic fallback', () => {
  it('composes the hostLaunchDirective line + the MCP-wired reminder', () => {
    const ctx: EmitContext = { root: '/tmp/demo' };
    const payload: HandoffPayload = {
      project: { id: 'p', name: 'demo' },
      host: 'gemini',
      task: null,
    };
    const block = defaultHandoffBlock(ctx, payload);
    // Composes the single-line directive (host-correct)…
    expect(block).toContain(hostLaunchDirective('gemini'));
    // …plus the reminder that the MCP wire is already configured.
    expect(block).toContain('noir.*');
    expect(block).toContain('`gemini`');
  });

  it('works for every supported host (no host-specific branching needed)', () => {
    const ctx: EmitContext = { root: '/tmp' };
    for (const host of SUPPORTED_HOSTS) {
      const payload: HandoffPayload = {
        project: { id: 'p', name: 'd' },
        host: host as HostId,
        task: null,
      };
      const block = defaultHandoffBlock(ctx, payload);
      expect(block).toContain(`Open \`${host}\``);
    }
  });
});

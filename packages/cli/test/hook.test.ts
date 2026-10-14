// The `noir hook` dispatch contract: host-dialect envelopes, the compiled
// budgeted brief, the deny-list, and the opt-in Stop gate. Offline/free — no
// network, no API key, no live host; behavior is pinned with stdin-JSON fixtures.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@noir-ai/store';
import { WorkflowEngine } from '@noir-ai/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compileBrief,
  dispatch,
  type EnforcementConfig,
  findNoirRoot,
  stopGateDecision,
} from '../src/commands/hook.js';

const ENFORCED: EnforcementConfig = { enabled: true, deny: [], stopGate: false };
const OFF: EnforcementConfig = { enabled: false, deny: [], stopGate: false };
const PID = '11111111-2222-4333-8444-555555555555';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-hook-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(): void {
  mkdirSync(join(root, '.noir', 'rules'), { recursive: true });
  writeFileSync(join(root, '.noir', 'router.md'), '# Noir skill router\n', 'utf8');
  writeFileSync(join(root, '.noir', 'rules', 'anti-slop.md'), 'noir-debt: be lazy\n', 'utf8');
}

describe('noir hook dispatch', () => {
  it('injects the compiled brief on SessionStart', () => {
    seed();
    const out = dispatch({ hook_event_name: 'SessionStart', cwd: root }, 'claude', ENFORCED, null);
    const parsed = JSON.parse(out.stdout ?? '') as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('# Noir skill router');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('noir-debt: be lazy');
  });

  it('omits additionalContext when no files exist', () => {
    const out = dispatch({ hook_event_name: 'SessionStart', cwd: root }, 'claude', ENFORCED, null);
    expect(JSON.parse(out.stdout ?? '')).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart' },
    });
  });

  it('emits cursor additional_context on SessionStart', () => {
    seed();
    const out = dispatch({ hook_event_name: 'SessionStart', cwd: root }, 'cursor', ENFORCED, null);
    const parsed = JSON.parse(out.stdout ?? '') as { additional_context: string };
    expect(parsed.additional_context).toContain('# Noir skill router');
  });

  it('finds .noir/ walking up from a subdirectory', () => {
    seed();
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(findNoirRoot(sub)).toBe(root);
  });

  it('denies a protected write on claude with a reason', () => {
    seed();
    const out = dispatch(
      {
        hook_event_name: 'PreToolUse',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: '.noir/.env' },
      },
      'claude',
      ENFORCED,
      null,
    );
    const parsed = JSON.parse(out.stdout ?? '') as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('.noir/.env');
  });

  it('denies on gemini via exit 2 + stderr reason (BeforeTool event)', () => {
    seed();
    const out = dispatch(
      {
        hook_event_name: 'BeforeTool',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: '.noir/.env' },
      },
      'gemini',
      ENFORCED,
      null,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('.noir/.env');
  });

  it('denies on cursor via exit 2 + stderr reason (preToolUse event)', () => {
    seed();
    const out = dispatch(
      {
        hook_event_name: 'preToolUse',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: '.noir/.env' },
      },
      'cursor',
      ENFORCED,
      null,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('.noir/.env');
  });

  it('injects the brief on cursor sessionStart', () => {
    seed();
    const out = dispatch({ hook_event_name: 'sessionStart', cwd: root }, 'cursor', ENFORCED, null);
    const parsed = JSON.parse(out.stdout ?? '') as { additional_context: string };
    expect(parsed.additional_context).toContain('# Noir skill router');
  });

  it('passes a normal source write', () => {
    const out = dispatch(
      {
        hook_event_name: 'PreToolUse',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: 'src/index.ts' },
      },
      'claude',
      ENFORCED,
      null,
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBeUndefined();
  });

  it('passes when enforcement is disabled', () => {
    const out = dispatch(
      {
        hook_event_name: 'PreToolUse',
        cwd: root,
        tool_name: 'Write',
        tool_input: { file_path: '.noir/.env' },
      },
      'claude',
      OFF,
      null,
    );
    expect(out.exitCode).toBe(0);
  });

  it('blocks Stop when the gate decision is a block', () => {
    const out = dispatch(
      { hook_event_name: 'Stop', cwd: root },
      'claude',
      { enabled: true, deny: [], stopGate: true },
      { block: true, reason: 'verify pending' },
    );
    expect(JSON.parse(out.stdout ?? '')).toEqual({ decision: 'block', reason: 'verify pending' });
  });

  it('passes Stop with no gate decision', () => {
    const out = dispatch({ hook_event_name: 'Stop', cwd: root }, 'claude', ENFORCED, null);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBeUndefined();
  });

  it('passes an unknown event', () => {
    const out = dispatch({ hook_event_name: 'Notification', cwd: root }, 'claude', ENFORCED, null);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBeUndefined();
  });
});

describe('compileBrief', () => {
  it('truncates under the budget', () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'router.md'), 'x'.repeat(12000), 'utf8');
    const brief = compileBrief(root);
    expect(brief.length).toBeLessThanOrEqual(9200);
    expect(brief).toContain('context truncated');
  });
});

describe('stopGateDecision', () => {
  it('fails open with no store', async () => {
    expect(await stopGateDecision(root)).toBeNull();
  });

  it('does not block a fresh intake task', async () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'project.id'), PID, 'utf8');
    const store = await openStore({ projectId: PID, root });
    const engine = new WorkflowEngine(store, root, PID);
    await engine.startTask('t1', 'demo', 'full');
    expect(await stopGateDecision(root)).toBeNull();
  });
});

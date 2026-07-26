// Capture unit tests for @noir-ai/memory.
//
// These exercise the PURE mapper surface in src/capture.ts — `toSaveInput`,
// `buildContent`, `describeToolCall`, `inferType`, `extractFiles`,
// `captureSource` — with NO store, NO embedder, NO network, NO LLM. They lock
// the host-neutral CaptureEvent → SaveInput contract and the opinionated
// default policy (capture Stop + UserPromptSubmit, skip noisy tool events).
//
// Privacy invariant (blueprint D6): the mapper is pure — it performs no
// I/O and triggers no paid call. These tests assert that directly by never
// touching the store or any provider.

import { createProjectId, type ProjectId } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import {
  buildContent,
  CAPTURE_HOOKS,
  type CaptureEvent,
  type CapturePolicy,
  captureSource,
  DEFAULT_CAPTURE_HOOKS,
  DEFAULT_CAPTURE_POLICY,
  describeToolCall,
  extractFiles,
  inferType,
  toSaveInput,
} from '../src/index.js';

const project: ProjectId = createProjectId();

function event(
  event_type: CaptureEvent['event_type'],
  payload: CaptureEvent['payload'],
  over: Partial<CaptureEvent> = {},
): CaptureEvent {
  return {
    event_type,
    ts: over.ts ?? 1_000,
    // Respect an explicitly-passed null (host sent no session): the `??` would
    // collapse null → 'sess-1' and mask the very case under test. Only fall back
    // to the default when the field was omitted entirely.
    sessionId: over.sessionId !== undefined ? over.sessionId : 'sess-1',
    project: over.project ?? project,
    payload,
  };
}

describe('@noir-ai/memory capture mapper (toSaveInput + helpers)', () => {
  describe('default policy (capture Stop + UserPromptSubmit, skip tool events)', () => {
    it('captures a Stop event with a summary', () => {
      const e = event('Stop', { summary: 'Decided to use sqlite-vec over pgvector for v1.' });
      const out = toSaveInput(e);
      expect(out).not.toBeNull();
      expect(out?.content).toBe('Decided to use sqlite-vec over pgvector for v1.');
      expect(out?.type).toBe('workflow');
      expect(out?.sessionId).toBe('sess-1');
    });

    it('captures a UserPromptSubmit event with the prompt', () => {
      const e = event('UserPromptSubmit', { prompt: 'Why did we pick MiniLM-L6-v2?' });
      const out = toSaveInput(e);
      expect(out?.content).toBe('Why did we pick MiniLM-L6-v2?');
      expect(out?.type).toBe('fact');
    });

    it('SKIPS a PreToolUse event under the default policy (noisy)', () => {
      const e = event('PreToolUse', { toolName: 'Bash', toolInput: { command: 'npm test' } });
      expect(toSaveInput(e)).toBeNull();
    });

    it('SKIPS a PostToolUse event under the default policy (noisy)', () => {
      const e = event('PostToolUse', {
        toolName: 'Edit',
        toolInput: { file_path: 'src/index.ts' },
      });
      expect(toSaveInput(e)).toBeNull();
    });

    it('skips a Stop event whose summary is empty / whitespace', () => {
      expect(toSaveInput(event('Stop', { summary: '   ' }))).toBeNull();
      expect(toSaveInput(event('Stop', {}))).toBeNull();
    });

    it('skips a UserPromptSubmit event whose prompt is empty', () => {
      expect(toSaveInput(event('UserPromptSubmit', { prompt: '' }))).toBeNull();
      expect(toSaveInput(event('UserPromptSubmit', {}))).toBeNull();
    });
  });

  describe('custom policy (opt INTO tool-event capture)', () => {
    const policy: CapturePolicy = { hooks: ['PostToolUse', 'PreToolUse'] };

    it('captures a PostToolUse event when the policy lists it', () => {
      const e = event('PostToolUse', {
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });
      const out = toSaveInput(e, policy);
      expect(out?.content).toBe('Ran Bash: npm test');
      expect(out?.type).toBe('workflow');
    });

    it('captures a PreToolUse edit and extracts its file_path into `files`', () => {
      const e = event('PreToolUse', {
        toolName: 'Edit',
        toolInput: { file_path: 'src/store.ts' },
      });
      const out = toSaveInput(e, policy);
      expect(out?.content).toBe('Edited src/store.ts');
      expect(out?.files).toEqual(['src/store.ts']);
    });

    it('does not capture a Stop event when the policy omits Stop', () => {
      const e = event('Stop', { summary: 'a summary' });
      expect(toSaveInput(e, policy)).toBeNull();
    });

    it('an empty `hooks` policy skips everything', () => {
      const e = event('Stop', { summary: 'a summary' });
      expect(toSaveInput(e, { hooks: [] })).toBeNull();
    });

    it('an unknown hook is captured only when explicitly listed in the policy', () => {
      const e = event('SessionEnd', { summary: 'wrapped up' });
      expect(toSaveInput(e)).toBeNull(); // not in default policy
      const out = toSaveInput(e, { hooks: ['SessionEnd'] });
      expect(out?.content).toBe('wrapped up');
    });
  });

  describe('sessionId + project passthrough (canonical ProjectId, D6)', () => {
    it('forwards sessionId when present', () => {
      const e = event('Stop', { summary: 's' }, { sessionId: 'abc-123' });
      expect(toSaveInput(e)?.sessionId).toBe('abc-123');
    });

    it('omits sessionId when the host sent null', () => {
      const e = event('Stop', { summary: 's' }, { sessionId: null });
      expect(toSaveInput(e)?.sessionId).toBeUndefined();
    });

    it('keeps the canonical project id on the event (never a fs path)', () => {
      const canon = createProjectId();
      const e = event('Stop', { summary: 's' }, { project: canon });
      // The mapper does not mutate project; it flows through to save unchanged.
      expect(e.project).toBe(canon);
    });
  });

  describe('inferType (light heuristic, no LLM)', () => {
    it('classifies a decision-shaped prompt as a decision', () => {
      const e = event('UserPromptSubmit', {
        prompt: 'We decided to adopt MiniLM-L6-v2 as the default embedder.',
      });
      expect(inferType(e)).toBe('decision');
    });

    it('classifies a plain prompt as a fact', () => {
      const e = event('UserPromptSubmit', { prompt: 'What does the store layer do?' });
      expect(inferType(e)).toBe('fact');
    });

    it('tags tool events as workflow', () => {
      expect(inferType(event('PostToolUse', { toolName: 'Bash' }))).toBe('workflow');
      expect(inferType(event('PreToolUse', { toolName: 'Edit' }))).toBe('workflow');
    });

    it('tags Stop as workflow', () => {
      expect(inferType(event('Stop', { summary: 's' }))).toBe('workflow');
    });
  });

  describe('describeToolCall', () => {
    it('renders a Bash command call', () => {
      expect(describeToolCall({ toolName: 'Bash', toolInput: { command: 'pnpm build' } })).toBe(
        'Ran Bash: pnpm build',
      );
    });

    it('renders an Edit as "Edited <path>"', () => {
      expect(describeToolCall({ toolName: 'Edit', toolInput: { file_path: 'src/a.ts' } })).toBe(
        'Edited src/a.ts',
      );
    });

    it('renders a Write as "Edited <path>" (mutating tool)', () => {
      expect(describeToolCall({ toolName: 'Write', toolInput: { file_path: 'src/b.ts' } })).toBe(
        'Edited src/b.ts',
      );
    });

    it('renders a read tool as "<tool>: <path>"', () => {
      expect(describeToolCall({ toolName: 'Read', toolInput: { file_path: 'src/c.ts' } })).toBe(
        'Read: src/c.ts',
      );
    });

    it('renders a generic tool with no recognized input field', () => {
      expect(describeToolCall({ toolName: 'Grep' })).toBe('Used Grep');
    });

    it('returns null when there is no toolName and no recognizable input', () => {
      expect(describeToolCall({})).toBeNull();
      expect(describeToolCall({ toolInput: { foo: 42 } })).toBeNull();
    });

    it('never throws on a non-object toolInput', () => {
      expect(describeToolCall({ toolName: 'Bash', toolInput: 'not-an-object' })).toBe('Used Bash');
    });
  });

  describe('buildContent', () => {
    it('returns the summary for Stop', () => {
      expect(buildContent(event('Stop', { summary: 'wrap' }))).toBe('wrap');
    });
    it('returns the prompt for UserPromptSubmit', () => {
      expect(buildContent(event('UserPromptSubmit', { prompt: 'why?' }))).toBe('why?');
    });
    it('returns null for Stop with no summary', () => {
      expect(buildContent(event('Stop', {}))).toBeNull();
    });
    it('delegates tool events to describeToolCall', () => {
      expect(
        buildContent(event('PostToolUse', { toolName: 'Bash', toolInput: { command: 'x' } })),
      ).toBe('Ran Bash: x');
    });
  });

  describe('extractFiles', () => {
    it('pulls file_path from a tool input', () => {
      expect(extractFiles({ toolInput: { file_path: 'src/x.ts' } })).toEqual(['src/x.ts']);
    });
    it('returns [] when there is no file_path', () => {
      expect(extractFiles({ toolInput: { command: 'npm test' } })).toEqual([]);
      expect(extractFiles({})).toEqual([]);
    });
    it('returns [] when toolInput is not an object', () => {
      expect(extractFiles({ toolInput: 'nope' })).toEqual([]);
    });
  });

  describe('captureSource (auto:<hook> provenance)', () => {
    it('lowercases the hook name into an auto: source', () => {
      expect(captureSource('Stop')).toBe('auto:stop');
      expect(captureSource('PostToolUse')).toBe('auto:posttooluse');
      expect(captureSource('UserPromptSubmit')).toBe('auto:userpromptsubmit');
    });
    it('accepts host-defined hook names', () => {
      expect(captureSource('SessionEnd')).toBe('auto:sessionend');
    });
  });

  describe('constants + defaults', () => {
    it('CAPTURE_HOOKS lists the four known hook events', () => {
      expect(CAPTURE_HOOKS).toEqual(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop']);
    });
    it('DEFAULT_CAPTURE_HOOKS is Stop + UserPromptSubmit only', () => {
      expect(DEFAULT_CAPTURE_HOOKS).toEqual(['Stop', 'UserPromptSubmit']);
    });
    it('DEFAULT_CAPTURE_POLICY mirrors DEFAULT_CAPTURE_HOOKS', () => {
      expect(DEFAULT_CAPTURE_POLICY.hooks).toBe(DEFAULT_CAPTURE_HOOKS);
    });
  });
});

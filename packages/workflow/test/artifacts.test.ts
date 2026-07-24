import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  writeAuditExport,
  writeChangelogStub,
  writeDecisionStub,
  writeIntake,
  writePlan,
  writeSpec,
  writeTask,
} from '../src/artifacts.js';
import type { GateResult } from '../src/types.js';

describe('ArtifactWriter', () => {
  let testRoot: string;
  const taskId = 'task-123';
  const slug = 'example-spec';

  beforeEach(() => {
    // Per-test isolated temp dir (parallelism-safe, like the store tests)
    testRoot = mkdtempSync(join(tmpdir(), 'noir-artifacts-'));
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  describe('writeIntake', () => {
    it('creates .noir/intake/<taskId>.md with the given content', () => {
      const content = '# Intake Notes\n\nSome context gathered during intake.';
      writeIntake(testRoot, taskId, content);

      const intakePath = join(testRoot, '.noir', 'intake', `${taskId}.md`);
      expect(existsSync(intakePath)).toBe(true);

      const fileContent = readFileSync(intakePath, 'utf-8');
      expect(fileContent).toBe(content);
    });
  });

  describe('writeSpec', () => {
    it('creates .noir/specs/<taskId>-<slug>.md with frontmatter and body', () => {
      const body = '# Example Spec\n\nThis is the spec content.';
      writeSpec(testRoot, taskId, slug, body);

      const specPath = paths.specFile(testRoot, taskId, slug);
      expect(existsSync(specPath)).toBe(true);

      const content = readFileSync(specPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain(`taskId: ${taskId}`);
      expect(content).toContain(`slug: ${slug}`);
      expect(content).toContain(body);
    });

    it('is idempotent - re-writing does not duplicate frontmatter', () => {
      const body1 = '# First Version\n\nContent 1';
      writeSpec(testRoot, taskId, slug, body1);

      const body2 = '# Second Version\n\nContent 2';
      writeSpec(testRoot, taskId, slug, body2);

      const specPath = paths.specFile(testRoot, taskId, slug);
      const content = readFileSync(specPath, 'utf-8');

      // Count frontmatter delimiters - should only have 2 (begin and end)
      const delimiterCount = (content.match(/^---$/gm) || []).length;
      expect(delimiterCount).toBe(2);

      // Should have second version content
      expect(content).toContain(body2);
      expect(content).not.toContain(body1);
    });
  });

  describe('writePlan', () => {
    it('creates .noir/plans/<taskId>-<slug>.md with frontmatter and body', () => {
      const body = '# Plan\n\nStep 1, then step 2.';
      writePlan(testRoot, taskId, slug, body);

      const planPath = paths.planFile(testRoot, taskId, slug);
      expect(existsSync(planPath)).toBe(true);

      const content = readFileSync(planPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain(`taskId: ${taskId}`);
      expect(content).toContain(`slug: ${slug}`);
      expect(content).toContain(body);
    });
  });

  describe('writeTask', () => {
    it('creates .noir/tasks/<taskId>-<taskName>.md with frontmatter and body', () => {
      const taskName = 'setup-db';
      const body = '# Task\n\nDo the thing.';
      writeTask(testRoot, taskId, taskName, body);

      const taskPath = paths.taskFile(testRoot, taskId, taskName);
      expect(existsSync(taskPath)).toBe(true);

      const content = readFileSync(taskPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain(`taskId: ${taskId}`);
      expect(content).toContain(`task: ${taskName}`);
      expect(content).toContain(body);
    });
  });

  describe('writeDecisionStub', () => {
    it('creates .noir/decisions/<n>.md with zero-padded name, title and pending status', () => {
      const n = 7;
      const title = 'Use hand-rolled FSM';
      writeDecisionStub(testRoot, n, title);

      const decisionPath = paths.decisionFile(testRoot, n);
      expect(existsSync(decisionPath)).toBe(true);
      // zero-padded to 4 digits
      expect(decisionPath.endsWith(join('decisions', '0007.md'))).toBe(true);

      const content = readFileSync(decisionPath, 'utf-8');
      expect(content).toContain(`# ${title}`);
      expect(content).toContain(`Decision record ${n}`);
      expect(content).toContain('Status: pending');
    });
  });

  describe('writeChangelogStub', () => {
    it('creates .noir/CHANGELOG.md with header + entry when file does not exist', () => {
      const entry = '- Initial release';
      writeChangelogStub(testRoot, entry);

      const changelogPath = join(testRoot, '.noir', 'CHANGELOG.md');
      expect(existsSync(changelogPath)).toBe(true);

      const content = readFileSync(changelogPath, 'utf-8');
      expect(content).toContain('# Changelog');
      expect(content).toContain(entry);
    });

    it('appends new entries, preserving the header and all prior entries', () => {
      const entry1 = '- First entry';
      const entry2 = '- Second entry';

      writeChangelogStub(testRoot, entry1);
      writeChangelogStub(testRoot, entry2);

      const changelogPath = join(testRoot, '.noir', 'CHANGELOG.md');
      const content = readFileSync(changelogPath, 'utf-8');

      // Header preserved across writes
      expect(content).toContain('# Changelog');
      // First entry survives the second write (append, not overwrite)
      expect(content).toContain(entry1);
      // Second entry appended
      expect(content).toContain(entry2);
      // Ordering: first entry appears before second entry
      expect(content.indexOf(entry1)).toBeLessThan(content.indexOf(entry2));
      // Only one header (no duplication)
      expect((content.match(/^# Changelog$/gm) || []).length).toBe(1);
    });
  });

  describe('writeAuditExport', () => {
    it('creates .noir/audit/<taskId>.json with GateResult array', () => {
      const results: GateResult[] = [
        {
          phase: 'spec',
          decision: 'approved',
          reason: 'All requirements met',
          at: 1234567890,
        },
        {
          phase: 'plan',
          decision: 'approved',
          at: 1234567891,
        },
      ];

      writeAuditExport(testRoot, taskId, results);

      const auditPath = paths.auditFile(testRoot, taskId);
      expect(existsSync(auditPath)).toBe(true);

      const content = readFileSync(auditPath, 'utf-8');
      const parsed = JSON.parse(content) as GateResult[];

      expect(parsed).toEqual(results);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].phase).toBe('spec');
      expect(parsed[1].phase).toBe('plan');
    });

    it('is idempotent - re-writing replaces entire file', () => {
      const results1: GateResult[] = [
        {
          phase: 'spec',
          decision: 'approved',
          at: 1234567890,
        },
      ];

      writeAuditExport(testRoot, taskId, results1);

      const results2: GateResult[] = [
        {
          phase: 'plan',
          decision: 'forced',
          reason: 'Manual override',
          at: 1234567891,
        },
      ];

      writeAuditExport(testRoot, taskId, results2);

      const auditPath = paths.auditFile(testRoot, taskId);
      const content = readFileSync(auditPath, 'utf-8');
      const parsed = JSON.parse(content) as GateResult[];

      expect(parsed).toEqual(results2);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].phase).toBe('plan');
    });
  });
});

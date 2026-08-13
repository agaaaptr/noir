import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, resolveArtifactPath } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    it('creates .noir/intake/IN-<NNNN>-<taskId>.md with frontmatter and content', () => {
      const content = '# Intake Notes\n\nSome context gathered during intake.';
      writeIntake(testRoot, taskId, content);

      const intakePath = resolveArtifactPath(testRoot, 'intake', { taskId });
      expect(existsSync(intakePath)).toBe(true);

      const fileContent = readFileSync(intakePath, 'utf-8');
      expect(fileContent).toContain('kind: intake');
      expect(fileContent).toContain(`id: ${taskId}`);
      expect(fileContent).toContain(content);
    });
  });

  describe('writeSpec', () => {
    it('creates .noir/specs/SP-<NNNN>-<taskId>-<slug>.md with frontmatter and body', () => {
      const body = '# Example Spec\n\nThis is the spec content.';
      writeSpec(testRoot, taskId, slug, body);

      const specPath = resolveArtifactPath(testRoot, 'spec', { taskId, slug });
      expect(existsSync(specPath)).toBe(true);

      const content = readFileSync(specPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('kind: spec');
      expect(content).toContain(`id: ${taskId}`);
      expect(content).toContain(`slug: ${slug}`);
      expect(content).toContain('status: draft');
      expect(content).toContain(body);
    });

    it('is idempotent - re-writing does not duplicate frontmatter', () => {
      const body1 = '# First Version\n\nContent 1';
      writeSpec(testRoot, taskId, slug, body1);

      const body2 = '# Second Version\n\nContent 2';
      writeSpec(testRoot, taskId, slug, body2);

      const specPath = resolveArtifactPath(testRoot, 'spec', { taskId, slug });
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
    it('creates .noir/plans/PL-<NNNN>-<taskId>-<slug>.md with frontmatter and body', () => {
      const body = '# Plan\n\nStep 1, then step 2.';
      writePlan(testRoot, taskId, slug, body);

      const planPath = resolveArtifactPath(testRoot, 'plan', { taskId, slug });
      expect(existsSync(planPath)).toBe(true);

      const content = readFileSync(planPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('kind: plan');
      expect(content).toContain(`id: ${taskId}`);
      expect(content).toContain(`slug: ${slug}`);
      expect(content).toContain(body);
    });
  });

  describe('writeTask', () => {
    it('creates .noir/tasks/TS-<NNNN>-<taskId>-<taskName>.md with frontmatter and body', () => {
      const taskName = 'setup-db';
      const body = '# Task\n\nDo the thing.';
      writeTask(testRoot, taskId, taskName, body);

      const taskPath = resolveArtifactPath(testRoot, 'task', { taskId, slug: taskName });
      expect(existsSync(taskPath)).toBe(true);

      const content = readFileSync(taskPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('kind: task');
      expect(content).toContain(`id: ${taskId}`);
      expect(content).toContain(`slug: ${taskName}`);
      expect(content).toContain(body);
    });
  });

  describe('writeDecisionStub', () => {
    it('creates .noir/decisions/ADR-<NNNN>-<slug>.md with the Nygard shape', () => {
      const n = 7;
      const dSlug = 'use-hand-rolled-fsm';
      const title = 'Use hand-rolled FSM';
      writeDecisionStub(testRoot, n, dSlug, title);

      const decisionPath = paths.decisionFile(testRoot, n, dSlug);
      expect(existsSync(decisionPath)).toBe(true);
      // zero-padded to 4 digits + type code
      expect(decisionPath.endsWith(join('decisions', 'ADR-0007-use-hand-rolled-fsm.md'))).toBe(
        true,
      );

      const content = readFileSync(decisionPath, 'utf-8');
      expect(content).toContain('kind: adr');
      expect(content).toContain(`id: ADR-0007`);
      expect(content).toContain('status: proposed');
      expect(content).toContain('# ADR-0007: Use hand-rolled FSM');
      expect(content).toContain('## Context');
      expect(content).toContain('## Decision');
      expect(content).toContain('## Consequences');
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

// Universal conflict contract. The artifact writers route through the
// SAME onConflict seam `regenerate` uses. Default behavior (no opts) stays
// v1.2 (overwrite); when a resolver is wired + interactive, differing files
// consult it; non-interactive guards prevent a prompt under CI/--json.
describe('artifact writers route through the conflict seam', () => {
  let root: string;
  const taskId = 'task-x';
  const slug = 'slug-x';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-artifacts-b2-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writeIntake default (no opts) overwrites differing content (v1.2 behavior)', () => {
    const p = resolveArtifactPath(root, 'intake', { taskId });
    mkdirSync(join(root, '.noir', 'intake'), { recursive: true });
    writeFileSync(p, 'USER', 'utf8');
    writeIntake(root, taskId, 'FRESH');
    expect(readFileSync(p, 'utf8')).toContain('FRESH');
  });

  it('writeIntake consults onConflict on a differing file (preserve keeps user bytes)', () => {
    const p = resolveArtifactPath(root, 'intake', { taskId });
    mkdirSync(join(root, '.noir', 'intake'), { recursive: true });
    writeFileSync(p, 'USER', 'utf8');
    const onConflict = vi.fn((): 'preserve' => 'preserve');
    writeIntake(root, taskId, 'FRESH', { onConflict, interactive: true });
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(readFileSync(p, 'utf8')).toBe('USER');
  });

  it('writeIntake does NOT consult under non-interactive (CI/--json never prompts)', () => {
    const p = resolveArtifactPath(root, 'intake', { taskId });
    mkdirSync(join(root, '.noir', 'intake'), { recursive: true });
    writeFileSync(p, 'USER', 'utf8');
    const onConflict = vi.fn((): 'preserve' => 'preserve');
    writeIntake(root, taskId, 'FRESH', { onConflict, interactive: false });
    expect(onConflict).not.toHaveBeenCalled();
  });

  it('writeSpec consults onConflict; rename moves the user aside then writes fresh', () => {
    // Pre-seed so the specFile exists with user bytes.
    const specPath = resolveArtifactPath(root, 'spec', { taskId, slug });
    mkdirSync(join(root, '.noir', 'specs'), { recursive: true });
    writeFileSync(specPath, 'USER', 'utf8');
    const onConflict = vi.fn((): 'rename' => 'rename');
    writeSpec(root, taskId, slug, 'BODY', { onConflict, interactive: true });
    expect(onConflict).toHaveBeenCalled();
    // The user's bytes moved to <specPath>.local; the fresh spec written in place.
    expect(existsSync(`${specPath}.local`)).toBe(true);
    expect(readFileSync(`${specPath}.local`, 'utf8')).toBe('USER');
    expect(readFileSync(specPath, 'utf8')).toContain('BODY');
  });

  it('writeIntake with no existing file always writes (no conflict)', () => {
    const onConflict = vi.fn((): 'preserve' => 'preserve');
    writeIntake(root, taskId, 'FRESH', { onConflict, interactive: true });
    expect(onConflict).not.toHaveBeenCalled();
    const p = resolveArtifactPath(root, 'intake', { taskId });
    expect(readFileSync(p, 'utf8')).toContain('FRESH');
  });
});

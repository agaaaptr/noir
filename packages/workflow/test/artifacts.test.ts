import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAuditExport, writeSpec } from '../src/artifacts.js';
import type { GateResult } from '../src/types.js';

describe('ArtifactWriter', () => {
  const testRoot = '/tmp/noir-artifacts-test';
  const taskId = 'task-123';
  const slug = 'example-spec';

  beforeEach(() => {
    // Clean up and create fresh test root
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(testRoot, { recursive: true, force: true });
  });

  describe('writeSpec', () => {
    it('creates .noir/specs/<taskId>-<slug>.md with frontmatter and body', () => {
      const body = '# Example Spec\n\nThis is the spec content.';
      writeSpec(testRoot, taskId, slug, body);

      const specPath = join(testRoot, '.noir', 'specs', `${taskId}-${slug}.md`);
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

      const specPath = join(testRoot, '.noir', 'specs', `${taskId}-${slug}.md`);
      const content = readFileSync(specPath, 'utf-8');

      // Count frontmatter delimiters - should only have 2 (begin and end)
      const delimiterCount = (content.match(/^---$/gm) || []).length;
      expect(delimiterCount).toBe(2);

      // Should have second version content
      expect(content).toContain(body2);
      expect(content).not.toContain(body1);
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

      const auditPath = join(testRoot, '.noir', 'audit', `${taskId}.json`);
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

      const auditPath = join(testRoot, '.noir', 'audit', `${taskId}.json`);
      const content = readFileSync(auditPath, 'utf-8');
      const parsed = JSON.parse(content) as GateResult[];

      expect(parsed).toEqual(results2);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].phase).toBe('plan');
    });
  });
});

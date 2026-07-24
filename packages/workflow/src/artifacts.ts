import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import type { GateResult } from './types.js';

/**
 * Write intake artifact to .noir/intake/<taskId>.md
 */
export function writeIntake(root: string, taskId: string, content: string): void {
  const dir = join(root, '.noir', 'intake');
  const file = join(dir, `${taskId}.md`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

/**
 * Write spec artifact to .noir/specs/<taskId>-<slug>.md
 * Creates markdown with frontmatter and body
 */
export function writeSpec(root: string, taskId: string, slug: string, body: string): void {
  const dir = paths.specsDir(root);
  const file = paths.specFile(root, taskId, slug);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
slug: ${slug}
---

${body}`;

  writeFileSync(file, content, 'utf-8');
}

/**
 * Write plan artifact to .noir/plans/<taskId>-<slug>.md
 */
export function writePlan(root: string, taskId: string, slug: string, body: string): void {
  const dir = paths.plansDir(root);
  const file = paths.planFile(root, taskId, slug);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
slug: ${slug}
---

${body}`;

  writeFileSync(file, content, 'utf-8');
}

/**
 * Write task artifact to .noir/tasks/<taskId>-<taskName>.md
 */
export function writeTask(root: string, taskId: string, taskName: string, body: string): void {
  const dir = paths.tasksDir(root);
  const file = paths.taskFile(root, taskId, taskName);

  mkdirSync(dir, { recursive: true });

  const content = `---
taskId: ${taskId}
task: ${taskName}
---

${body}`;

  writeFileSync(file, content, 'utf-8');
}

/**
 * Write decision stub to .noir/decisions/<n>.md
 */
export function writeDecisionStub(root: string, n: number, title: string): void {
  const dir = paths.decisionsDir(root);
  const file = paths.decisionFile(root, n);

  mkdirSync(dir, { recursive: true });

  const content = `# ${title}

*Decision record ${n}*

<!-- Status: pending -->
`;

  writeFileSync(file, content, 'utf-8');
}

/**
 * Write changelog stub entry to .noir/CHANGELOG.md
 */
export function writeChangelogStub(root: string, entry: string): void {
  const file = join(root, '.noir', 'CHANGELOG.md');

  // Create directory if it doesn't exist
  mkdirSync(join(root, '.noir'), { recursive: true });

  let content: string;
  if (existsSync(file)) {
    // Append: read existing content and add the new entry on its own line,
    // preserving the header and all prior entries.
    const existing = readFileSync(file, 'utf-8');
    const prefix = existing.endsWith('\n') ? existing : `${existing}\n`;
    content = `${prefix}${entry}\n`;
  } else {
    content = `# Changelog

${entry}
`;
  }

  writeFileSync(file, content, 'utf-8');
}

/**
 * Write audit export to .noir/audit/<taskId>.json
 * Exports GateResult array as JSON
 */
export function writeAuditExport(root: string, taskId: string, results: GateResult[]): void {
  const dir = paths.auditDir(root);
  const file = paths.auditFile(root, taskId);

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(results, null, 2), 'utf-8');
}

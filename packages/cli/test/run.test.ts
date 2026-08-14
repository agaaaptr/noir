// v2 — `noir run` variadic prompt parsing (regression: a multi-word prompt was
// silently dropped because commander delivers `[prompt...]` as a nested array,
// and the old `args.filter(isString).join(' ')` read nothing). This drives the
// real commander tree and asserts the joined prompt reaches the run command.
import { describe, expect, it, vi } from 'vitest';

// `./commands/run.js` is imported STATICALLY by bin.ts, so the mock factory
// runs at bin.ts load time — hoist the spy so it is defined before then.
const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn(async (_prompt: string, _opts: unknown): Promise<void> => {}),
}));
vi.mock('../src/commands/run.js', () => ({ run: runMock }));

import { createProgram } from '../src/bin.js';

describe('noir run — variadic prompt parsing', () => {
  it('joins a multi-word prompt and passes it to the run command', async () => {
    const program = createProgram();
    await program.parseAsync(['run', 'explain', 'what', 'this', 'repo', 'does'], { from: 'user' });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toBe('explain what this repo does');
  });

  it('passes the --command custom-binary override through', async () => {
    runMock.mockClear();
    const program = createProgram();
    await program.parseAsync(['run', 'hi', '--command', 'claude-work'], { from: 'user' });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toBe('hi');
    const opts = runMock.mock.calls[0]?.[1] as { command?: string } | undefined;
    expect(opts?.command).toBe('claude-work');
  });
});

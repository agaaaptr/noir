// The transcript picker and the store behind it.
//
// A run leaves its raw stream-json in `.noir/transcripts/`, and this is how a
// past run comes back: listed newest first, opened read-only, and re-rendered
// through the same fold the live screen uses. The screen is driven here over an
// in-memory store, and the filesystem store is exercised against a temp root —
// so neither test writes into the repository or depends on a real run having
// happened.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type TuiDeps } from '../../src/tui/App.js';
import { TranscriptPicker } from '../../src/tui/modes/transcripts.js';
import {
  createTranscriptStore,
  TRANSCRIPT_LIST_LIMIT,
  type TranscriptEntry,
  type TranscriptStore,
  transcriptDir,
} from '../../src/tui/transcripts.js';

const ESC = '';
const ENTER = '\r';
const DOWN = '[B';

/** Resolve after a short macrotask so an async list/read can land. */
function flush(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ENTRY: TranscriptEntry = {
  path: '/tmp/transcripts/claude-run.jsonl',
  name: 'claude-run.jsonl',
  sizeBytes: 412,
  mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5),
};

/** An in-memory store: no directory, no writes, deterministic answers. */
function fakeStore(
  over: Partial<TranscriptStore> = {},
): TranscriptStore & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    list: async () => [ENTRY],
    read: async (path) => {
      reads.push(path);
      return [
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'The parser is fixed.' }] },
        }),
      ];
    },
    write: async () => ENTRY.path,
    ...over,
  };
}

function mount(store: TranscriptStore): {
  readonly instance: ReturnType<typeof render>;
  readonly exit: ReturnType<typeof vi.fn>;
} {
  const exit = vi.fn();
  const element = (
    <TranscriptPicker transcripts={store} onExit={exit} />
  ) as unknown as ReactElement;
  return { instance: render(element), exit };
}

describe('transcript picker', () => {
  it('lists the recent transcripts and opens one read-only', async () => {
    const store = fakeStore();
    const m = mount(store);
    await flush();

    const listFrame = m.instance.lastFrame() ?? '';
    expect(listFrame).toContain('claude-run.jsonl');
    expect(listFrame).toContain('412 bytes');

    m.instance.stdin.write(ENTER);
    await flush(80);
    expect(store.reads).toEqual([ENTRY.path]);
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toContain('The parser is fixed.');
    expect(frame).toContain('read-only');
    m.instance.unmount();
  });

  it('steps back from an open transcript to the list, then out', async () => {
    const m = mount(fakeStore());
    await flush();
    m.instance.stdin.write(ENTER);
    await flush(80);
    m.instance.stdin.write(ESC);
    await flush(60);
    expect(m.instance.lastFrame() ?? '').toContain('claude-run.jsonl');
    expect(m.exit).not.toHaveBeenCalled();

    m.instance.stdin.write(ESC);
    await flush(60);
    expect(m.exit).toHaveBeenCalled();
    m.instance.unmount();
  });

  it('moves the selection with the arrow keys', async () => {
    const older: TranscriptEntry = {
      ...ENTRY,
      path: '/tmp/transcripts/older.jsonl',
      name: 'older.jsonl',
    };
    const store = fakeStore({ list: async () => [ENTRY, older] });
    const m = mount(store);
    await flush();

    m.instance.stdin.write(DOWN);
    await flush(40);
    m.instance.stdin.write(ENTER);
    await flush(80);
    expect(store.reads).toEqual([older.path]);
    m.instance.unmount();
  });

  it('says so when there is nothing to open', async () => {
    const m = mount(fakeStore({ list: async () => [] }));
    await flush();
    expect(m.instance.lastFrame() ?? '').toContain('no transcripts yet');
    m.instance.unmount();
  });

  it('treats an unlistable store as no transcripts rather than an error', async () => {
    const m = mount(
      fakeStore({
        list: async () => {
          throw new Error('EACCES');
        },
      }),
    );
    await flush();
    expect(m.instance.lastFrame() ?? '').toContain('no transcripts yet');
    m.instance.unmount();
  });
});

describe('transcript store', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /** A temp project root with `n` named transcript files. */
  function withFiles(spec: readonly { name: string; mtimeMs: number }[]): TranscriptStore {
    root = mkdtempSync(join(tmpdir(), 'noir-transcripts-'));
    const dir = transcriptDir(root);
    mkdirSync(dir, { recursive: true });
    for (const file of spec) {
      const path = join(dir, file.name);
      writeFileSync(path, '{"type":"system"}\n');
      // The listing sorts by mtime, so the fixture's times are the order under
      // test — and setting one explicitly is the only way to make that order
      // deterministic rather than dependent on how fast the loop ran.
      const seconds = file.mtimeMs / 1000;
      utimesSync(path, seconds, seconds);
    }
    writeFileSync(join(root, 'not-a-transcript.txt'), 'ignored\n');
    return createTranscriptStore({ host: 'claude', root });
  }

  it('lists only transcripts, newest first, and honours the limit', async () => {
    const store = withFiles([
      { name: 'claude-old.jsonl', mtimeMs: Date.UTC(2026, 0, 1) },
      { name: 'claude-new.jsonl', mtimeMs: Date.UTC(2026, 0, 3) },
      { name: 'claude-mid.jsonl', mtimeMs: Date.UTC(2026, 0, 2) },
    ]);
    const all = await store.list();
    expect(all.map((e) => e.name)).toEqual([
      'claude-new.jsonl',
      'claude-mid.jsonl',
      'claude-old.jsonl',
    ]);
    expect(all[0]?.sizeBytes).toBeGreaterThan(0);

    const one = await store.list(1);
    expect(one.map((e) => e.name)).toEqual(['claude-new.jsonl']);
  });

  it('answers an absent directory with an empty list', async () => {
    root = mkdtempSync(join(tmpdir(), 'noir-transcripts-empty-'));
    const store = createTranscriptStore({ host: 'claude', root });
    expect(await store.list()).toEqual([]);
    expect(await store.read(join(transcriptDir(root), 'nope.jsonl'))).toEqual([]);
  });

  it('reads a persisted transcript back line by line', async () => {
    const store = withFiles([{ name: 'claude-run.jsonl', mtimeMs: Date.UTC(2026, 0, 1) }]);
    const dir = transcriptDir(root as string);
    writeFileSync(join(dir, 'claude-run.jsonl'), 'one\ntwo\n');
    expect(await store.read(join(dir, 'claude-run.jsonl'))).toEqual(['one', 'two', '']);
  });

  it('refuses to read outside its own directory', async () => {
    const store = withFiles([{ name: 'claude-run.jsonl', mtimeMs: Date.UTC(2026, 0, 1) }]);
    const outside = join(root as string, 'not-a-transcript.txt');
    expect(await store.read(outside)).toEqual([]);
    // A sibling directory whose name merely starts with the same prefix is not
    // inside it either.
    const sibling = `${transcriptDir(root as string)}-other`;
    expect(await store.read(join(sibling, 'claude-run.jsonl'))).toEqual([]);
  });

  it('offers a bounded list by default', () => {
    expect(TRANSCRIPT_LIST_LIMIT).toBeGreaterThan(0);
  });

  it('persists a run into the project it is rooted at, and lists it back', async () => {
    root = mkdtempSync(join(tmpdir(), 'noir-transcripts-write-'));
    const store = createTranscriptStore({ host: 'claude', root });
    // The writer resolves the project root the way `noir run` does, so the
    // working directory IS the seam here.
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(await store.write(['{"type":"system"}', '{"type":"result"}'])).toContain(
        join('.noir', 'transcripts'),
      );
    } finally {
      process.chdir(cwd);
    }
    const listed = await store.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.name.startsWith('claude-')).toBe(true);
    expect(await store.read(listed[0]?.path ?? '')).toEqual([
      '{"type":"system"}',
      '{"type":"result"}',
      '',
    ]);
  });
});

describe('the dashboard binding', () => {
  it('opens the picker on Ctrl+T and returns to the dashboard on Esc', async () => {
    const store = fakeStore();
    const deps: TuiDeps = {
      dispatch: async () => {},
      fetchStatus: async () => null,
      commands: [],
      record: async () => {},
      loadRecent: async () => [],
      run: {
        start: () => {
          throw new Error('not started in this test');
        },
        actions: () => [],
        perform: async () => ({ ok: true, message: '' }),
        transcripts: store,
      },
    };
    const instance = render((<App deps={deps} refreshMs={600000} />) as unknown as ReactElement);
    await flush(60);

    instance.stdin.write(''); // Ctrl+T
    await flush(80);
    expect(instance.lastFrame() ?? '').toContain('claude-run.jsonl');

    instance.stdin.write(ESC);
    await flush(60);
    expect(instance.lastFrame() ?? '').toContain('/command');
    instance.unmount();
  });
});

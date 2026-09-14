// The recent-transcript store behind the TUI's transcript picker.
//
// `noir run` writes the host's raw stream-json to `.noir/transcripts/`, and
// until now nothing could read it back: the audit record of a run existed on
// disk and was reachable only by knowing the path. The store lists what is
// there, newest first, and reads one back so the run screen can render it.
//
// It is a seam (an interface plus one filesystem implementation) so the TUI can
// be driven in a test without a run ever writing into the repository — and so
// the persistence rules live in one place: the same 0700 directory and 0600
// file the CLI's own runs create, because a transcript quotes raw host output
// and prompts, which can contain credentials.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { writeTranscript } from '../commands/run.js';

/** One persisted transcript, as the picker lists it. */
export interface TranscriptEntry {
  /** Absolute path — what {@link TranscriptStore.read} takes back. */
  readonly path: string;
  /** Base name, which is what the picker shows. */
  readonly name: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface TranscriptStore {
  /** The most recent transcripts, newest first. */
  list(limit?: number): Promise<readonly TranscriptEntry[]>;
  /** The raw stream-json lines of one transcript, in order. */
  read(path: string): Promise<readonly string[]>;
  /** Persist a run's raw lines; returns the path (or a "not persisted" note). */
  write(lines: readonly string[]): Promise<string>;
}

/** How many transcripts the picker offers before it stops being a short list. */
export const TRANSCRIPT_LIST_LIMIT = 20;

/** The transcript directory under `root`, where every run persists its stream. */
export function transcriptDir(root: string = process.cwd()): string {
  return join(root, '.noir', 'transcripts');
}

/**
 * The filesystem-backed store the TUI uses. Reads are best-effort and answered
 * with empty results rather than errors: an unreadable or absent directory is
 * "no transcripts yet", which is a state the picker renders, not a failure the
 * user has to dismiss.
 */
export function createTranscriptStore(opts: {
  /** The host label the file name is built from (`claude`, `claude-work`, …). */
  readonly host: string;
  /** Project root (defaults to the working directory). */
  readonly root?: string;
}): TranscriptStore {
  const root = opts.root ?? process.cwd();
  const dir = transcriptDir(root);
  return {
    list: async (limit = TRANSCRIPT_LIST_LIMIT) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const entries: TranscriptEntry[] = [];
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        try {
          const info = statSync(path);
          if (!info.isFile()) continue;
          entries.push({ path, name, sizeBytes: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // A file that vanished between the listing and the stat is simply not
          // in the list.
        }
      }
      // Newest first: the run a user wants back is almost always the last one.
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
      return entries.slice(0, Math.max(0, limit));
    },
    read: async (path: string) => {
      // Only this project's own transcripts: the picker hands back paths it was
      // given, but the seam is public and a read is a read.
      const resolved = resolve(path);
      if (resolved !== resolve(dir) && !resolved.startsWith(resolve(dir) + sep)) return [];
      try {
        return readFileSync(resolved, 'utf8').split('\n');
      } catch {
        return [];
      }
    },
    write: async (lines: readonly string[]) => {
      // Delegates to the CLI's own writer so a run started from the TUI lands in
      // the same place, with the same permissions, as one started from a shell.
      return writeTranscript(opts.host, lines);
    },
  };
}

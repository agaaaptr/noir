// Post-run actions for `noir run`: a short menu offered once a successful run
// has finished, so the answer that just streamed past can be put somewhere —
// memory, a task finding, a handoff artifact, a file — or the session can be
// continued, without leaving the terminal to re-open an editor or the host.
//
// Every action delegates to a command seam that already exists (`memory
// capture`, `task research record`, `handoff`, a fresh host invocation, a file
// write) instead of talking to the daemon itself: the single-writer, privacy
// and exit-code contracts keep living in one place per concern. "Continue this
// session" is a NEW invocation of the same single-shot run path — the host is
// spawned, streams, and exits exactly as before; Noir never keeps a session
// alive between turns.
//
// Two laws hold here. The menu is offered only on a terminal that allows
// prompts, so `--json`, `--no-input`, CI and piped runs never see it and keep
// their exact previous output. And nothing here may change the finished run's
// exit code: an action that fails (daemon down, no active task, an unwritable
// path) is reported and dropped, never escalated.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommanderError } from 'commander';
import { handoff } from './commands/handoff.js';
import { memoryCapture } from './commands/memory.js';
import { taskResearchRecord } from './commands/task.js';
import { type CliOptions, isInteractive, NoirCliError, success, warn } from './output.js';

/** What the menu can do with a finished run. */
type PostRunAction = 'memory' | 'research' | 'handoff' | 'resume' | 'save' | 'dismiss';

/** One rendered menu row. */
interface MenuOption {
  readonly value: PostRunAction;
  readonly label: string;
  readonly hint: string;
}

export interface PostRunActionInput {
  /** The host's answer as plain text — what was streamed to stdout. */
  readonly answer: string;
  /** Path of the raw stream-json transcript, quoted in the prompts. */
  readonly transcript: string;
  /** The host's session id, when it reported one. */
  readonly sessionId?: string;
  /** The host binary that just ran, named in the prompts. */
  readonly host: string;
  readonly opts: CliOptions;
  /**
   * Continue an existing session with a prompt collected fresh. Absent when
   * continuing is not on offer (no session id was reported, or this run is
   * itself the continuation) — the menu drops the option rather than rendering
   * a dead row.
   */
  readonly resume?: (prompt: string, sessionId: string) => Promise<void>;
}

/** The provenance a post-run capture carries into memory. */
const CAPTURE_EVENT = 'capture';

/** Provenance for a research finding: the run itself is the evidence. */
const RESEARCH_SOURCE = 'noir run';

/** The daemon caps a research finding at 220 characters and refuses more. */
const RESEARCH_TEXT_LIMIT = 220;

/** The @clack module, typed from its dynamic import (it loads lazily). */
type Clack = typeof import('@clack/prompts');

/**
 * Offer the actions for a finished run. Returns immediately — before loading
 * the prompt library — when the invocation is not interactive, which is what
 * keeps a scripted or piped run byte-identical to one made before this menu
 * existed. A cancelled or dismissed menu is a no-op, not an error.
 */
export async function offerPostRunActions(input: PostRunActionInput): Promise<void> {
  if (!isInteractive(input.opts)) return;

  const answer = input.answer.trim();
  const canContinue = input.sessionId !== undefined && input.resume !== undefined;
  const options: MenuOption[] = [];
  // Only the actions that actually have something to work with: an empty
  // answer has nothing to save, and a run that reported no session id has
  // nothing to continue.
  if (answer.length > 0) {
    options.push({
      value: 'memory',
      label: 'Save answer to memory',
      hint: "distil it into this project's memory (needs the daemon)",
    });
    options.push({
      value: 'research',
      label: 'Add as task research',
      hint: 'record it as a finding on the active task',
    });
  }
  options.push({
    value: 'handoff',
    label: 'Write a handoff artifact',
    hint: 'snapshot the task, the next step and a seed for your host',
  });
  if (canContinue) {
    options.push({
      value: 'resume',
      label: 'Continue this session',
      hint: `ask ${input.host} a follow-up in the same session`,
    });
  }
  if (answer.length > 0) {
    options.push({
      value: 'save',
      label: 'Save answer to a file',
      hint: 'write the answer text to a path you choose',
    });
  }
  options.push({
    value: 'dismiss',
    label: 'Dismiss',
    hint: 'nothing further — the run is already complete',
  });
  // A menu whose only row is "Dismiss" is not worth a keystroke.
  if (options.length <= 1) return;

  const clack = await import('@clack/prompts');
  const choice = await clack.select({
    message: 'The run finished. What next?',
    initialValue: 'dismiss',
    options,
  });
  if (clack.isCancel(choice)) return;

  switch (choice as PostRunAction) {
    case 'memory':
      await attempt('Saving to memory', input.opts, () => saveToMemory(input));
      return;
    case 'research':
      await attempt('Recording the finding', input.opts, () => recordAsResearch(input));
      return;
    case 'handoff':
      await attempt('Writing the handoff', input.opts, () => writeHandoff(input));
      return;
    case 'resume':
      await attempt('Continuing the session', input.opts, () => continueSession(input, clack));
      return;
    case 'save':
      await attempt('Writing the file', input.opts, () => saveAnswerToFile(input, clack));
      return;
    case 'dismiss':
      return;
  }
}

/**
 * Run one action, keeping the finished run's exit code intact. A failure here
 * is reported and dropped: the run is already complete and reported, and a
 * follow-up the user can simply retry must not rewrite its result.
 */
async function attempt(
  label: string,
  opts: CliOptions,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    // `fail()` and the daemon client both write their own diagnostic before
    // throwing, so only an unexpected error is quoted here — and the second
    // line always runs, so a failure is never silent.
    if (!(err instanceof CommanderError) && !(err instanceof NoirCliError)) {
      warn(`${label}: ${err instanceof Error ? err.message : String(err)}`, opts);
    }
    warn(`${label} did not complete — the run's result stands.`, opts);
  }
}

/** Save the answer through the existing memory-capture command. */
async function saveToMemory(input: PostRunActionInput): Promise<void> {
  await memoryCapture({
    ...input.opts,
    content: input.answer,
    eventType: CAPTURE_EVENT,
  });
}

/** Record the answer as a research finding on the active task. */
async function recordAsResearch(input: PostRunActionInput): Promise<void> {
  await taskResearchRecord({
    ...input.opts,
    type: 'discovery',
    text: researchText(input.answer),
    source: RESEARCH_SOURCE,
  });
}

/**
 * The finding text: whitespace collapsed onto one line and cut to the length
 * the daemon accepts (it refuses more). An over-long answer still lands as a
 * usable pointer rather than failing the whole action.
 */
function researchText(answer: string): string {
  const condensed = answer.replace(/\s+/g, ' ').trim();
  if (condensed.length <= RESEARCH_TEXT_LIMIT) return condensed;
  return `${condensed.slice(0, RESEARCH_TEXT_LIMIT - 1)}…`;
}

/** Write the handoff artifact through the existing handoff command. */
async function writeHandoff(input: PostRunActionInput): Promise<void> {
  await handoff({ ...input.opts, write: true });
}

/** Ask the host a follow-up in the session that just finished. */
async function continueSession(input: PostRunActionInput, clack: Clack): Promise<void> {
  const { sessionId, resume } = input;
  if (sessionId === undefined || resume === undefined) return;
  const written = await clack.text({
    message: `What should ${input.host} do next?`,
    placeholder: 'e.g. now write the tests for that',
  });
  if (clack.isCancel(written)) return;
  const prompt = String(written ?? '').trim();
  if (prompt.length === 0) {
    warn('No prompt given — the session was not continued.', input.opts);
    return;
  }
  await resume(prompt, sessionId);
}

/** Write the accumulated answer text to a path the user chooses. */
async function saveAnswerToFile(input: PostRunActionInput, clack: Clack): Promise<void> {
  const fallback = `noir-run-${stamp()}.md`;
  const written = await clack.text({
    message: `Write the answer to a file (the raw transcript is at ${input.transcript})`,
    placeholder: fallback,
  });
  if (clack.isCancel(written)) return;
  const chosen = String(written ?? '').trim();
  const target = resolve(chosen.length > 0 ? chosen : fallback);
  const body = input.answer.endsWith('\n') ? input.answer : `${input.answer}\n`;
  try {
    // The answer can quote credentials or private code, so a newly created
    // file is owner-only — the same reason the transcript is 0600.
    writeFileSync(target, body, { mode: 0o600 });
  } catch (err) {
    warn(
      `could not write ${target}: ${err instanceof Error ? err.message : String(err)}`,
      input.opts,
    );
    return;
  }
  success(`Answer written to ${target}`, input.opts);
}

/** A filesystem-safe stamp for the default file name. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

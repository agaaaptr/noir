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
// Three laws hold here. The menu is offered only on a terminal that allows
// prompts, so `--json`, `--no-input`, CI and piped runs never see it and keep
// their exact previous output. Nothing here may change the finished run's exit
// code: an action that fails (daemon down, no active task, an unwritable path)
// is reported and dropped, never escalated. And the menu is ONE definition
// shared by two surfaces — the terminal prompt and the TUI's overlay — so the
// actions, their order and their wording cannot drift between them: the surface
// decides how a row is drawn and where a value is typed, the performer decides
// what a choice does.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommanderError } from 'commander';
import { handoff } from './commands/handoff.js';
import { memoryCapture } from './commands/memory.js';
import { taskResearchRecord } from './commands/task.js';
import { type CliOptions, isInteractive, NoirCliError, success, warn } from './output.js';

/** What the menu can do with a finished run. */
export type PostRunAction = 'memory' | 'research' | 'handoff' | 'resume' | 'save' | 'dismiss';

/** One rendered menu row. */
export interface PostRunMenuOption {
  readonly value: PostRunAction;
  readonly label: string;
  readonly hint: string;
  /**
   * The value this row needs collected before it can run — a prompt for a
   * continuation, a path for a file write. A surface that can ask for it (the
   * terminal prompt does; the TUI draws its own input line) reads the label and
   * placeholder from here rather than guessing them, so the question it asks is
   * the same one.
   */
  readonly needsValue?: { readonly label: string; readonly placeholder: string };
}

/** What performing an action did. Reported, never thrown. */
export interface PostRunOutcome {
  /** Whether the action did what it said it would. */
  readonly ok: boolean;
  /** The line to show. Empty when the action's own command output is the report. */
  readonly message: string;
  /**
   * The underlying cause, quoted only when it has not already been reported by
   * the command that threw.
   */
  readonly detail?: string;
  /** How the line reads: a confirmation, or a caution. Defaults from `ok`. */
  readonly tone?: 'confirm' | 'caution';
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
  /**
   * Whether a continuation is on offer, overriding the `resume` rule above. A
   * surface that continues a session ITSELF — the TUI starts another turn on
   * the same screen — says so here, rather than having to hand over a function
   * it would never call. Absent means "ask the `resume` seam".
   */
  readonly canContinue?: boolean;
}

/** The provenance a post-run capture carries into memory. */
const CAPTURE_EVENT = 'capture';

/** Provenance for a research finding: the run itself is the evidence. */
const RESEARCH_SOURCE = 'noir run';

/** The daemon caps a research finding at 220 characters and refuses more. */
const RESEARCH_TEXT_LIMIT = 220;

/** How each action is named while it runs, and in a failure it reports. */
const ACTION_LABEL: Record<PostRunAction, string> = {
  memory: 'Saving to memory',
  research: 'Recording the finding',
  handoff: 'Writing the handoff',
  resume: 'Continuing the session',
  save: 'Writing the file',
  dismiss: 'Dismissing',
};

/** The @clack module, typed from its dynamic import (it loads lazily). */
type Clack = typeof import('@clack/prompts');

/**
 * The actions on offer for this run, in the order they are shown. Only the ones
 * that actually have something to work with: an empty answer has nothing to
 * save, and a run that reported no session id has nothing to continue.
 */
export function postRunActions(input: PostRunActionInput): PostRunMenuOption[] {
  const answer = input.answer.trim();
  const canContinue =
    input.canContinue ?? (input.sessionId !== undefined && input.resume !== undefined);
  const options: PostRunMenuOption[] = [];
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
      needsValue: {
        label: 'follow-up prompt',
        placeholder: 'e.g. now write the tests for that',
      },
    });
  }
  if (answer.length > 0) {
    options.push({
      value: 'save',
      label: 'Save answer to a file',
      hint: 'write the answer text to a path you choose',
      needsValue: { label: 'file path', placeholder: 'e.g. notes/answer.md' },
    });
  }
  options.push({
    value: 'dismiss',
    label: 'Dismiss',
    hint: 'nothing further — the run is already complete',
  });
  return options;
}

/**
 * Do one chosen action and report what happened. Never throws: the caller is
 * showing the outcome of a run that has already succeeded, and a follow-up that
 * failed must not become that run's result.
 *
 * `value` is whatever the surface collected for a row that declares
 * {@link PostRunMenuOption.needsValue} — a prompt, or a file path.
 */
export async function performPostRunAction(
  choice: PostRunAction,
  input: PostRunActionInput,
  value?: string,
): Promise<PostRunOutcome> {
  const label = ACTION_LABEL[choice];
  try {
    switch (choice) {
      case 'memory':
        await saveToMemory(input);
        return { ok: true, message: '' };
      case 'research':
        await recordAsResearch(input);
        return { ok: true, message: '' };
      case 'handoff':
        await writeHandoff(input);
        return { ok: true, message: '' };
      case 'resume':
        return await continueSession(input, value);
      case 'save':
        return saveAnswerToFile(input, value);
      case 'dismiss':
        return { ok: true, message: '' };
    }
  } catch (err) {
    // A path that already reported its own diagnostic (`fail()` and the daemon
    // client both write before throwing) is not quoted back a second time.
    const quoted =
      err instanceof CommanderError || err instanceof NoirCliError
        ? undefined
        : `${label}: ${err instanceof Error ? err.message : String(err)}`;
    return {
      ok: false,
      message: `${label} did not complete — the run's result stands.`,
      ...(quoted === undefined ? {} : { detail: quoted }),
    };
  }
}

/**
 * Offer the actions for a finished run. Returns immediately — before loading
 * the prompt library — when the invocation is not interactive, which is what
 * keeps a scripted or piped run byte-identical to one made before this menu
 * existed. A cancelled, dismissed, or undrawable menu is a no-op, not an error:
 * the run has already succeeded and been reported, so the prompt itself can
 * never be the thing that fails it.
 */
export async function offerPostRunActions(input: PostRunActionInput): Promise<void> {
  if (!isInteractive(input.opts)) return;

  const options = postRunActions(input);
  // A menu whose only row is "Dismiss" is not worth a keystroke.
  if (options.length <= 1) return;

  const menu = await openMenu(options);
  if (menu === undefined) return;
  const chosen = options.find((o) => o.value === menu.choice);
  if (chosen === undefined) return;

  // The value is collected on the same prompt library, and a cancelled or
  // unusable one abandons the action the same way the menu itself does.
  const value =
    chosen.needsValue === undefined ? undefined : await askForValue(menu.clack, chosen, input);
  if (chosen.needsValue !== undefined && value === undefined) return;

  report(await performPostRunAction(menu.choice, input, value), input.opts);
}

/**
 * Render what an action did. A confirmation prints as one; a caution — or a
 * failure — prints as a diagnostic, and a failure quotes its cause only when
 * the cause has not already been printed by whoever threw.
 */
function report(outcome: PostRunOutcome, opts: CliOptions): void {
  const caution = outcome.tone === 'caution' || (!outcome.ok && outcome.tone !== 'confirm');
  if (outcome.detail !== undefined) warn(outcome.detail, opts);
  if (outcome.message.length === 0) return;
  if (caution) warn(outcome.message, opts);
  else success(outcome.message, opts);
}

/**
 * Draw the menu and return what was chosen, or `undefined` when the user wants
 * nothing. Loading the prompt library, rendering the question, and reading the
 * answer are all one step on purpose: every way this can fail — the library not
 * loading, the terminal going away between the interactivity gate and the
 * render, stdin erroring — costs the menu and nothing else. It is an offer on a
 * run that has already succeeded and been reported, so it must never be the
 * thing that turns that run into a failure.
 */
async function openMenu(
  options: readonly PostRunMenuOption[],
): Promise<{ clack: Clack; choice: PostRunAction } | undefined> {
  try {
    const clack = await import('@clack/prompts');
    const choice = await clack.select({
      message: 'The run finished. What next?',
      initialValue: 'dismiss',
      // Spread because the prompt library takes a mutable list; the rows
      // themselves are the shared descriptors and are never rewritten.
      options: [...options],
    });
    if (clack.isCancel(choice)) return undefined;
    return { clack, choice: choice as PostRunAction };
  } catch {
    return undefined;
  }
}

/**
 * Ask for the value a row declared it needs. `undefined` means the user backed
 * out (or the prompt could not be drawn), which abandons the action — an empty
 * answer is NOT a back-out, and is handed on so each action can decide what an
 * empty value means (a generated file name, or nothing to continue with).
 */
async function askForValue(
  clack: Clack,
  option: PostRunMenuOption,
  input: PostRunActionInput,
): Promise<string | undefined> {
  const needs = option.needsValue;
  if (needs === undefined) return undefined;
  const message =
    option.value === 'save'
      ? `Write the answer to a file (the raw transcript is at ${input.transcript})`
      : `What should ${input.host} do next?`;
  try {
    const written = await clack.text({ message, placeholder: needs.placeholder });
    if (clack.isCancel(written)) return undefined;
    return String(written ?? '');
  } catch {
    return undefined;
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
async function continueSession(
  input: PostRunActionInput,
  value: string | undefined,
): Promise<PostRunOutcome> {
  const { sessionId, resume } = input;
  if (sessionId === undefined || resume === undefined) return { ok: true, message: '' };
  const prompt = (value ?? '').trim();
  if (prompt.length === 0) {
    return {
      ok: true,
      tone: 'caution',
      message: 'No prompt given — the session was not continued.',
    };
  }
  await resume(prompt, sessionId);
  return { ok: true, message: '' };
}

/** Write the accumulated answer text to a path the user chooses. */
function saveAnswerToFile(input: PostRunActionInput, value: string | undefined): PostRunOutcome {
  const fallback = `noir-run-${stamp()}.md`;
  const chosen = (value ?? '').trim();
  const target = resolve(chosen.length > 0 ? chosen : fallback);
  const body = input.answer.endsWith('\n') ? input.answer : `${input.answer}\n`;
  try {
    // The answer can quote credentials or private code, so a newly created
    // file is owner-only — the same reason the transcript is 0600.
    writeFileSync(target, body, { mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      tone: 'caution',
      message: `could not write ${target}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, message: `Answer written to ${target}` };
}

/** A filesystem-safe stamp for the default file name. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

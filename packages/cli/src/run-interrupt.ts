// Stopping a host run: the interrupt contract shared by `noir run` and the
// TUI's live run screen.
//
// A run drives a host CLI as a child process. Stopping it is a two-step ladder
// — the polite signal first, the forceful one after a grace — because a host
// that ignores the polite signal would otherwise hold the terminal (or the run
// screen) open for good. The child is never detached: it lives in Noir's own
// process group, so this ladder is what guarantees it is gone before Noir
// leaves. An interrupt that reported success and exited early would leave a
// live host behind, holding the user's credentials and their terminal.

import { constants } from 'node:os';
import { type HostChild, signalChild } from './orchestrator.js';

/**
 * How long the polite signal gets before the forceful one. A host that is
 * mid-request needs a moment to wind down and finish writing its own record of
 * the session; a host that ignores the signal entirely must not hold the
 * terminal past this.
 */
export const INTERRUPT_GRACE_MS = 5000;

/** The signals a run answers, in the order they are installed. */
export const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** One of the signals a run answers. */
export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** The exit code a run leaves with when `signal` stopped it: 128 + its number. */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + ((constants.signals as Record<string, number>)[signal] ?? 0);
}

/** What an interrupted run says — the terminal and the run screen alike. */
export function interruptedNotice(transcript: string): string {
  return `interrupted · transcript: ${transcript}`;
}

export interface RunInterruptOptions {
  /** Grace between the polite signal and the forceful one. */
  readonly graceMs?: number;
  /** Leave at once, without cleaning up. How a second interrupt is honoured. */
  readonly exitNow?: (code: number) => void;
}

/**
 * The interrupt state of one run: the child that is live, and what has been
 * asked of it.
 *
 * The caller hands over every child a spawn produces (a run whose binary is
 * reached through the shell bridge produces a second one), and calls
 * {@link terminate} to stop — from a signal handler in the terminal, or from a
 * keystroke on the run screen. Both arrive here, so the kill path is the same
 * one in both cases.
 */
export class RunInterrupt {
  private readonly graceMs: number;
  private readonly exitNow: (code: number) => void;
  private readonly controller = new AbortController();
  /** The live child, or undefined between spawns. */
  private child: HostChild | undefined;
  /** The child the ladder already ran for — a repeat call is not a new ladder. */
  private stopping: HostChild | undefined;
  private grace: NodeJS.Timeout | undefined;
  private signalName: InterruptSignal | undefined;
  private stopRequested = false;
  private forced = false;
  private watching = false;
  /** The installed listeners, keyed by the signal each answers. */
  private readonly handlers = new Map<InterruptSignal, () => void>();

  constructor(opts: RunInterruptOptions = {}) {
    this.graceMs = opts.graceMs ?? INTERRUPT_GRACE_MS;
    this.exitNow = opts.exitNow ?? ((code: number): void => process.exit(code));
  }

  /**
   * The cancel signal for the spawn. Aborting it is what a caller holding only
   * the signal can do; the ladder itself does not depend on it, which matters
   * because the child a run ends up driving is not always the first one spawned.
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The signal that stopped the run, or undefined when nothing did. */
  get interruptedBy(): InterruptSignal | undefined {
    return this.signalName;
  }

  /** True once a child had to be forced — it did not honour the polite signal. */
  get escalated(): boolean {
    return this.forced;
  }

  /**
   * Hand over the child a spawn produced. Called for every spawn of one run: a
   * command resolved through the shell bridge is its own child, and a stop that
   * arrived before that child existed has to land on it too.
   */
  track(child: HostChild): void {
    this.child = child;
    child.once('exit', () => this.forget(child));
    if (this.stopRequested) this.terminate();
  }

  /**
   * Stop the host. The polite signal goes to the child itself, and a child still
   * alive after the grace is forced. Repeat calls are the same call: the ladder
   * runs once per child, so a keystroke held down is not a stream of signals.
   */
  terminate(): void {
    this.stopRequested = true;
    if (!this.controller.signal.aborted) this.controller.abort();
    const child = this.child;
    // Nothing spawned yet, or the spawn that was attempted failed and left no
    // process behind: the request is remembered, and `track` runs the ladder on
    // the child the next spawn produces.
    if (child === undefined || child.pid === undefined || child === this.stopping) return;
    this.stopping = child;
    this.clearGrace();
    signalChild(child, 'SIGTERM');
    this.grace = setTimeout(() => {
      this.grace = undefined;
      // Gone, or replaced by a newer spawn: there is nothing left to force.
      if (this.child !== child) return;
      this.forced = true;
      signalChild(child, 'SIGKILL');
    }, this.graceMs);
  }

  /**
   * Install the terminal interrupt handlers. Only a run installs these, and only
   * for as long as it is driving the host: the process's own handling has to
   * come back afterwards, or a later command inherits an interrupt contract with
   * nothing left to interrupt.
   */
  watch(): void {
    if (this.watching) return;
    this.watching = true;
    // One listener per signal, each knowing which signal it is: the name is
    // carried by the closure rather than read off the callback's argument, so
    // this behaves the same whether the signal came from the OS or from code
    // that raised it directly.
    for (const signal of INTERRUPT_SIGNALS) {
      const listener = (): void => this.onSignal(signal);
      this.handlers.set(signal, listener);
      process.on(signal, listener);
    }
  }

  /** Put the process's own handling back, whatever the run left behind. */
  unwatch(): void {
    if (!this.watching) return;
    this.watching = false;
    for (const [signal, listener] of this.handlers) process.off(signal, listener);
    this.handlers.clear();
  }

  private onSignal(signal: InterruptSignal): void {
    if (this.signalName !== undefined) {
      // A second interrupt is the user insisting. Honour it at once rather than
      // waiting out a grace the child may be ignoring.
      this.exitNow(exitCodeForSignal(signal));
      return;
    }
    this.signalName = signal;
    this.terminate();
  }

  /** The child is gone: stop tracking it and disarm its ladder. */
  private forget(child: HostChild): void {
    if (this.child !== child) return; // a newer spawn owns the ladder now
    this.child = undefined;
    this.stopping = undefined;
    this.clearGrace();
  }

  private clearGrace(): void {
    if (this.grace === undefined) return;
    clearTimeout(this.grace);
    this.grace = undefined;
  }
}

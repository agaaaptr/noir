// Stopping a host run: the interrupt contract.
//
// A run drives a host as a child process, so "stop" has to reach THAT process,
// has to escalate when the host ignores the polite signal, and has to leave
// nothing running behind Noir. This file drives the contract with a fake child
// and fake timers: the ordering (polite signal → grace → forceful signal) and
// the exit codes are asserted without a host, a terminal, or a real wait.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostChild } from '../src/orchestrator.js';
import {
  exitCodeForSignal,
  INTERRUPT_GRACE_MS,
  interruptedNotice,
  RunInterrupt,
} from '../src/run-interrupt.js';

/** A child that records the signals it was sent, and dies when told to. */
class FakeChild extends EventEmitter implements HostChild {
  readonly signals: NodeJS.Signals[] = [];
  readonly pid = 4242;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }
  /** It is gone: a signal it accepted, or its own exit. */
  gone(): void {
    this.emit('exit');
  }
}

/** Every controller a test built, so no handler outlives its test. */
const watching: RunInterrupt[] = [];
function newInterrupt(opts?: ConstructorParameters<typeof RunInterrupt>[0]): RunInterrupt {
  const interrupt = new RunInterrupt(opts);
  watching.push(interrupt);
  return interrupt;
}

afterEach(() => {
  for (const interrupt of watching.splice(0)) interrupt.unwatch();
  vi.useRealTimers();
});

describe('the interrupt convention', () => {
  it('maps each signal onto the shell exit code for it', () => {
    expect(exitCodeForSignal('SIGINT')).toBe(130);
    expect(exitCodeForSignal('SIGTERM')).toBe(143);
  });

  it('says what happened and where the record of it is, in one shape', () => {
    expect(interruptedNotice('/tmp/t.jsonl')).toBe('interrupted · transcript: /tmp/t.jsonl');
    expect(interruptedNotice('(not persisted)')).toBe('interrupted · transcript: (not persisted)');
  });
});

describe('RunInterrupt — the kill ladder', () => {
  it('asks the child to stop first, and does not force it before the grace', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    const child = new FakeChild();
    interrupt.track(child);

    interrupt.terminate();
    expect(child.signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(INTERRUPT_GRACE_MS - 1);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(interrupt.escalated).toBe(false);
  });

  it('forces a child that is still alive after the grace', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    const child = new FakeChild();
    interrupt.track(child);

    interrupt.terminate();
    vi.advanceTimersByTime(INTERRUPT_GRACE_MS);

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(interrupt.escalated).toBe(true);
  });

  it('never forces a child that honoured the signal in time', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    const child = new FakeChild();
    interrupt.track(child);

    interrupt.terminate();
    child.gone();
    vi.advanceTimersByTime(INTERRUPT_GRACE_MS * 4);

    // The ladder is disarmed by the child leaving, not merely by the timer
    // winning the race: a late force would reach a pid that may be reused.
    expect(child.signals).toEqual(['SIGTERM']);
    expect(interrupt.escalated).toBe(false);
  });

  it('treats a repeated stop as the same stop', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    const child = new FakeChild();
    interrupt.track(child);

    interrupt.terminate();
    interrupt.terminate();
    vi.advanceTimersByTime(INTERRUPT_GRACE_MS);

    // One ladder per child: a keystroke held down is not a stream of signals.
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops a child that only appears after the stop was asked for', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    interrupt.terminate(); // nothing spawned yet

    const child = new FakeChild();
    interrupt.track(child);

    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('runs its own ladder for a second child — the one the shell bridge spawned', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    const first = new FakeChild();
    interrupt.track(first);
    interrupt.terminate();
    first.gone(); // the name did not spawn; a second child is on its way

    const second = new FakeChild();
    interrupt.track(second);
    expect(second.signals).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(INTERRUPT_GRACE_MS);
    expect(second.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('never signals a spawn that produced no process', () => {
    vi.useFakeTimers();
    const interrupt = newInterrupt();
    const failed = new FakeChild();
    // What a spawn that failed leaves behind: a handle with no pid. Signalling
    // it would mean pid 0 — every process in Noir's own group.
    Object.defineProperty(failed, 'pid', { value: undefined });
    const kill = vi.spyOn(failed, 'kill');
    interrupt.track(failed);

    interrupt.terminate();
    vi.advanceTimersByTime(INTERRUPT_GRACE_MS * 2);

    expect(kill).not.toHaveBeenCalled();
    expect(interrupt.escalated).toBe(false);
  });

  it('aborts the cancel signal too, so a spawn that has not happened yet is covered', () => {
    const interrupt = newInterrupt();
    expect(interrupt.signal.aborted).toBe(false);
    interrupt.terminate();
    expect(interrupt.signal.aborted).toBe(true);
  });
});

describe('RunInterrupt — terminal signals', () => {
  it('answers SIGINT by stopping the host and recording which signal it was', () => {
    const interrupt = newInterrupt();
    const child = new FakeChild();
    interrupt.track(child);
    interrupt.watch();

    process.emit('SIGINT');

    expect(child.signals).toEqual(['SIGTERM']);
    expect(interrupt.interruptedBy).toBe('SIGINT');
    expect(exitCodeForSignal(interrupt.interruptedBy as NodeJS.Signals)).toBe(130);
  });

  it('answers SIGTERM the same way, with the SIGTERM exit code', () => {
    const interrupt = newInterrupt();
    const child = new FakeChild();
    interrupt.track(child);
    interrupt.watch();

    process.emit('SIGTERM');

    expect(child.signals).toEqual(['SIGTERM']);
    expect(exitCodeForSignal(interrupt.interruptedBy as NodeJS.Signals)).toBe(143);
  });

  it('leaves at once on a second signal rather than waiting out the grace', () => {
    vi.useFakeTimers();
    const exitNow = vi.fn();
    const interrupt = newInterrupt({ exitNow });
    const child = new FakeChild();
    interrupt.track(child);
    interrupt.watch();

    process.emit('SIGTERM');
    process.emit('SIGTERM');

    // The host is ignoring the polite signal; a user who asked twice does not
    // want to wait the grace out.
    expect(exitNow).toHaveBeenCalledWith(143);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('puts the process’s own handling back when the run is over', () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    const interrupt = newInterrupt();
    interrupt.watch();
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1);

    interrupt.unwatch();
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);

    // A signal after the run is not this run's business any more.
    const child = new FakeChild();
    interrupt.track(child);
    process.emit('SIGTERM');
    expect(child.signals).toEqual([]);
    expect(interrupt.interruptedBy).toBeUndefined();
  });

  it('is installed once, however many times it is asked to watch', () => {
    const before = process.listenerCount('SIGINT');
    const interrupt = newInterrupt();
    interrupt.watch();
    interrupt.watch();
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });
});

// A test-only render harness that can put the TUI on a terminal of any width.
//
// `ink-testing-library`'s stdout shim answers a hard-coded 100 for `columns`,
// with no way to ask for anything else, so every test built on it lays the
// dashboard out for a 100-column terminal. That is how the narrow-terminal
// layout defects reached users: the width a bug needed could not be expressed
// in a test. This harness takes the width as a parameter.
//
// The frames still come from Ink's own `render` — nothing about the TUI is
// stubbed. Ink asks the stream it draws on for only two things: somewhere to
// write a frame, and the `columns` to lay it out for. So the injected stdout is
// a small EventEmitter that reports the requested width, and the frames it
// receives are the ones a real terminal of that width would show.
//
// Read the frame before unmounting it: layouts are asserted on a live frame,
// and `unmount()` freezes the harness so Ink's teardown output (a trailing
// newline, cursor restores) can never become the frame a later assertion reads.

import { EventEmitter } from 'node:events';
import { render } from 'ink';
import type { ReactElement } from 'react';

/**
 * The stdout Ink draws on: a write sink that reports a fixed width. Non-TTY by
 * design, which keeps Ink in its deterministic non-interactive mode (no cursor
 * escapes, no resize handling) while still writing a frame per render.
 */
class WidthStdout extends EventEmitter {
  readonly isTTY = false;
  // Reported alongside `columns` so Ink never falls back to measuring the
  // machine the test runs on: the width is the only thing this stream decides.
  readonly rows = 24;
  private last = '';
  private frozen = false;

  constructor(private readonly width: number) {
    super();
  }

  /** The terminal width Ink lays the tree out for. */
  get columns(): number {
    return this.width;
  }

  write = (chunk: string): boolean => {
    if (!this.frozen) {
      this.last = chunk;
    }
    return true;
  };

  /** The most recent frame, or the empty string if nothing has been drawn. */
  lastFrame(): string {
    return this.last;
  }

  /** Stop recording: everything written from here on is teardown output. */
  freeze(): void {
    this.frozen = true;
  }
}

/** The stderr sink: present so a stray write cannot reach the real terminal. */
class Sink extends EventEmitter {
  write = (): boolean => true;
}

/**
 * A stdin that supports raw mode, matching the fake TTY the existing TUI tests
 * render against. Components that call `useInput` (the App does) attach their
 * listeners here; no input is ever delivered, which is all a layout assertion
 * needs.
 */
class TestStdin extends EventEmitter {
  readonly isTTY = true;

  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): null => null;
}

/** A mounted frame at a chosen width. Read `frame()` before you `unmount()`. */
export interface WidthHarness {
  /** The frame as last drawn, laid out for the requested width. */
  frame(): string;
  /** Unmount the app and freeze the frame it left behind. */
  unmount(): void;
}

/**
 * Render `node` onto a terminal `columns` wide and return its frame.
 *
 * ```tsx
 * const view = renderAtWidth(<Footer />, 80);
 * expect(displayWidth(view.frame())).toBeLessThanOrEqual(80);
 * view.unmount();
 * ```
 */
export function renderAtWidth(node: ReactElement, columns: number): WidthHarness {
  const stdout = new WidthStdout(columns);
  const stderr = new Sink();
  const stdin = new TestStdin();
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    // Debug mode writes a frame on every render instead of repainting in place,
    // so the frame is there to read as soon as `render` returns — the same
    // options the shared testing library renders with.
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  let unmounted = false;
  return {
    frame: () => stdout.lastFrame(),
    unmount: () => {
      if (unmounted) {
        return;
      }
      unmounted = true;
      stdout.freeze();
      instance.unmount();
    },
  };
}

import { describe, it, expect } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render, Box, Static } from 'ink';
import stringWidth from 'string-width';
import { MessageLine } from './MessageLine.js';

const h = React.createElement;
const COLS = 80;

/**
 * REGRESSION (Conor, 2026-08-12 screenshots): Ink's <Static> positions its
 * subtree absolutely, so it never inherits the terminal-width constraint.
 * Without an explicit width pin, message text wraps at the FULL terminal
 * width, renders GUTTER_WIDTH columns to the right, and the physical line
 * overflows the terminal — the terminal then hard-wraps the last 1–3
 * characters to column 0 ("th", ".", "ca" fragments). ChatApp pins
 * <Static style={{ width }}> to the real width; this test renders the same
 * structure and asserts no emitted line exceeds the terminal width.
 */

class FakeStdout extends EventEmitter {
  columns = COLS;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
    return true;
  }
}

const LONG_ASCII =
  'Therapy finished 45 minutes ago! It ends up there is some timezone confusion due to daylight ' +
  'savings. Go ahead and create another therapy session for me for next Wednesday at 9am PT with ' +
  'Richard. We can update the event to include the information after.';

const LONG_EVENT =
  '🛠 myra · remember (executed) — {"success":true,"message":"Memory saved successfully",' +
  '"user":{"id":"00000000-0000-0000-0000-000000000000"},"memory":{"id":"9639846a-1f22"}}';

const MESSAGES = [
  { id: 'm1', role: 'user' as const, content: LONG_ASCII, label: 'you', time: '11:02 AM' },
  { id: 'm2', role: 'assistant' as const, content: LONG_ASCII, label: 'myra', time: '11:02 AM' },
  { id: 'm3', role: 'event' as const, content: LONG_EVENT },
];

function StaticApp() {
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { items: MESSAGES, style: { width: COLS } }, (msg: (typeof MESSAGES)[number]) =>
      h(MessageLine, {
        key: msg.id,
        id: msg.id,
        role: msg.role,
        content: msg.content,
        label: (msg as { label?: string }).label,
        time: (msg as { time?: string }).time,
      })
    )
  );
}

describe('<Static> width pin (scrollback wrap-overflow regression)', () => {
  it('never emits a physical line wider than the terminal', async () => {
    const stdout = new FakeStdout();
    const inst = render(h(StaticApp), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    inst.unmount();

    const all = stdout.frames.join('');
    // string-width is ANSI-aware (it strips escape sequences before
    // measuring), so raw frame lines can be measured directly.
    const lines = all.split('\n');

    // Sanity: the content actually rendered (wrapped across lines).
    expect(all).toContain('Therapy finished 45 minutes ago!');

    for (const line of lines) {
      expect(
        stringWidth(line),
        'overwide line: ' + JSON.stringify(line.slice(0, 100))
      ).toBeLessThanOrEqual(COLS);
    }
  });
});

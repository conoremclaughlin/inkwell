import React from 'react';
import { render } from 'ink';
import { ChatApp, type ChatAppHandle, type ChatMessage } from './ChatApp.js';
import type { MessageRole } from './MessageLine.js';
import { formatNow } from '../tui-components.js';

/**
 * Deferred promise helper — creates a promise with externally-exposed resolve/reject.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The InkRepl is the bridge between the existing chat orchestration (pull-based
 * while loop) and the Ink rendering tree (push-based React callbacks).
 *
 * It exposes:
 * - `waitForInput()` — drop-in replacement for `rl.question()`
 * - `addMessage()` — replaces `printLine(renderMessageLine(...))`
 * - `setStatus()` — replaces `statusLane.renderSummary()`
 * - `setWaiting()` — replaces `startWaitingIndicator()`
 * - `setInfoItems()` — replaces `statusLane.setInfoItems()`
 * - `cleanup()` — unmount the Ink app
 */
export interface InkRepl {
  /** Block until the user submits a line (replaces rl.question). */
  waitForInput: () => Promise<string>;
  /** Push a chat message into the scrollback. */
  addMessage: (
    role: MessageRole,
    content: string,
    options?: {
      label?: string;
      time?: string;
      trailingMeta?: string;
    }
  ) => void;
  /** Print a system/info line (replaces printLine for non-message output). */
  printSystem: (content: string) => void;
  /** Update the status bar summary. */
  setStatus: (summary: string) => void;
  /** Show/hide the waiting indicator. */
  setWaiting: (waiting: boolean, backend?: string) => void;
  /** Update the info bar items. */
  setInfoItems: (items: string[]) => void;
  /** Signal exit from the orchestrator side (makes waitForInput reject). */
  requestExit: () => void;
  /** Unmount the Ink app and restore terminal. */
  cleanup: () => void;
  /** The raw ChatAppHandle for advanced use. */
  handle: ChatAppHandle;
}

let messageCounter = 0;
function nextMessageId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

/**
 * Mount the Ink chat UI and return the bridge adapter.
 *
 * The adapter makes the push-based Ink app look pull-based to the existing
 * chat orchestrator: `waitForInput()` returns a promise that resolves when
 * the user presses Enter in the Ink PromptInput.
 */
export function renderInkChat(options: {
  agentId: string;
  timezone?: string;
  infoItems: string[];
}): InkRepl {
  const handleRef =
    React.createRef<ChatAppHandle>() as React.MutableRefObject<ChatAppHandle | null>;

  // Pending input promise — resolved when user submits a line
  let pendingInput: ReturnType<typeof deferred<string>> | null = null;

  // Exit signal
  let exitRequested = false;

  const onUserInput = (raw: string) => {
    if (pendingInput) {
      pendingInput.resolve(raw);
      pendingInput = null;
    }
  };

  const onExit = () => {
    exitRequested = true;
    // If someone is waiting for input, reject with a sentinel
    if (pendingInput) {
      pendingInput.reject(new InkExitSignal());
      pendingInput = null;
    }
  };

  // On resize, clear the visible screen and let Ink re-render from scratch.
  // Scrollback is preserved (user can scroll up). This is the only reliable
  // way to handle terminal reflow — Ink's line tracker can't account for how
  // old content wraps at the new width.
  const onResize = () => {
    process.stdout.write('\x1b[2J');
  };
  process.stdout.on('resize', onResize);

  // Mount the Ink app (its internal resize handler registers AFTER ours)
  const { unmount } = render(
    <ChatApp
      ref={handleRef}
      agentId={options.agentId}
      timezone={options.timezone}
      infoItems={options.infoItems}
      onUserInput={onUserInput}
      onExit={onExit}
    />
  );

  // Get the handle (available synchronously after render)
  const getHandle = (): ChatAppHandle => {
    if (!handleRef.current) {
      throw new Error('ChatApp handle not available — component may not have mounted');
    }
    return handleRef.current;
  };

  const repl: InkRepl = {
    waitForInput: () => {
      if (exitRequested) {
        return Promise.reject(new InkExitSignal());
      }
      pendingInput = deferred<string>();
      return pendingInput.promise;
    },

    addMessage: (role, content, opts) => {
      getHandle().addMessage({
        id: nextMessageId(),
        role,
        content,
        label: opts?.label,
        time: opts?.time || formatNow(options.timezone),
        trailingMeta: opts?.trailingMeta,
      });
    },

    printSystem: (content) => {
      getHandle().addMessage({
        id: nextMessageId(),
        role: 'system',
        content,
        time: formatNow(options.timezone),
      });
    },

    setStatus: (summary) => {
      getHandle().setStatusSummary(summary);
    },

    setWaiting: (waiting, backend) => {
      getHandle().setWaiting(waiting, backend);
    },

    setInfoItems: (items) => {
      getHandle().setInfoItems(items);
    },

    requestExit: () => {
      onExit();
    },

    cleanup: () => {
      process.stdout.off('resize', onResize);
      unmount();
    },

    get handle() {
      return getHandle();
    },
  };

  return repl;
}

/**
 * Sentinel error thrown when the user requests exit (double Ctrl+C or /quit).
 * The REPL loop catches this to break out of the while loop.
 */
export class InkExitSignal extends Error {
  constructor() {
    super('InkExitSignal');
    this.name = 'InkExitSignal';
  }
}

import React from 'react';
import { render } from 'ink';
import { ChatApp, type ChatAppHandle, type ChatMessage } from './ChatApp.js';
import { SessionPicker, type SessionPickerEntry } from './SessionPicker.js';
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
      /** Streamed paragraph after the first: content only, no label row. */
      continuation?: boolean;
    }
  ) => void;
  /** Print a system/info line (replaces printLine for non-message output). */
  printSystem: (content: string) => void;
  /**
   * Print a compact progress/status event line (tool runs, signals,
   * dividers). Renders as a single dim line without a label row.
   */
  printEvent: (content: string) => void;
  /** Update the status bar summary. */
  setStatus: (summary: string) => void;
  /** Show/hide the waiting indicator. */
  setWaiting: (waiting: boolean, backend?: string) => void;
  /** Update the info bar items. */
  setInfoItems: (items: string[]) => void;
  /** Register an abort handler for the current backend turn. */
  setAbortHandler: (handler: (() => void) | null) => void;
  /** Show command output in the dock panel (below prompt, above info bar). */
  setCommandOutput: (lines: string[] | null) => void;
  /** Store surfaced memory details for Ctrl+O expansion. */
  setSurfacedMemories: (lines: string[]) => void;
  /** Open the context viewer with formatted lines (optionally at a section). */
  showContextView: (lines: string[], opts?: { initialSection?: string }) => void;
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
  fullscreen?: boolean;
  dynamicMessages?: boolean;
}): InkRepl {
  const handleRef =
    React.createRef<ChatAppHandle>() as React.MutableRefObject<ChatAppHandle | null>;
  const fullscreen = !!options.fullscreen;

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

  // <Static> handles scroll protection: completed messages go to terminal scrollback,
  // only the dock (~6 lines) is dynamic. Cursor movement is bounded to dock height.
  // incrementalRendering: line-by-line diffing for the dynamic portion.
  // alternateBuffer (--fullscreen): optional app-controlled viewport.
  const { unmount } = render(
    <ChatApp
      ref={handleRef}
      agentId={options.agentId}
      timezone={options.timezone}
      infoItems={options.infoItems}
      fullscreen={fullscreen}
      dynamicMessages={!!options.dynamicMessages}
      onUserInput={onUserInput}
      onExit={onExit}
    />,
    { alternateScreen: fullscreen, incrementalRendering: true, exitOnCtrlC: false }
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
        continuation: opts?.continuation,
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

    printEvent: (content) => {
      getHandle().addMessage({
        id: nextMessageId(),
        role: 'event',
        content,
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

    setAbortHandler: (handler) => {
      getHandle().setAbortHandler(handler);
    },

    setCommandOutput: (lines) => {
      getHandle().setCommandOutput(lines);
    },

    setSurfacedMemories: (lines) => {
      getHandle().setSurfacedMemories(lines);
    },

    showContextView: (lines, opts) => {
      getHandle().showContextView(lines, opts);
    },

    requestExit: () => {
      onExit();
    },

    cleanup: () => {
      unmount();
    },

    get handle() {
      return getHandle();
    },
  };

  return repl;
}

/**
 * Show a session picker UI and return the user's selection.
 * Returns the selected entry, or null for "new session".
 */
export function renderSessionPicker(
  entries: SessionPickerEntry[]
): Promise<SessionPickerEntry | null | undefined> {
  return new Promise((resolve) => {
    const onSelect = (entry: SessionPickerEntry | null) => {
      unmount();
      resolve(entry);
    };
    const onCancel = () => {
      unmount();
      resolve(undefined);
    };

    const { unmount } = render(
      <SessionPicker entries={entries} onSelect={onSelect} onCancel={onCancel} />
    );
  });
}

export type { SessionPickerEntry };

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

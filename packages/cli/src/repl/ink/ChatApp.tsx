import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { ContextViewer } from './context-viewer.js';
import { Dock } from './Dock.js';
import { MessageLine, type MessageLineProps } from './MessageLine.js';
import { formatNow } from '../tui-components.js';

const WAITING_VERBS = [
  'Thinking',
  'Pondering',
  'Reasoning',
  'Considering',
  'Composing',
  'Reflecting',
  'Contemplating',
  'Synthesizing',
  'Connecting dots',
  'Neurons firing',
  'Weaving thoughts',
  'Mulling it over',
];

const SPINNER_CHAR = '✦';

export interface ChatMessage extends MessageLineProps {
  id: string;
}

export interface ChatAppProps {
  agentId: string;
  timezone?: string;
  infoItems: string[];
  fullscreen?: boolean;
  /** Render all messages dynamically (re-renderable) instead of write-once Static. */
  dynamicMessages?: boolean;
  /** Called when the user submits a message from the prompt. */
  onUserInput: (raw: string) => void;
  /** Called when the user requests exit (double Ctrl+C). */
  onExit: () => void;
}

/**
 * External handle for pushing state into the ChatApp from outside React.
 */
export interface ChatAppHandle {
  addMessage: (msg: ChatMessage) => void;
  setStatusSummary: (summary: string) => void;
  setWaiting: (waiting: boolean, backend?: string) => void;
  setInfoItems: (items: string[]) => void;
  setAbortHandler: (handler: (() => void) | null) => void;
  setCommandOutput: (lines: string[] | null) => void;
  setSurfacedMemories: (lines: string[]) => void;
  /** Open the context viewer with the given lines. */
  showContextView: (lines: string[]) => void;
  /** Register callback for Ctrl+O (orchestrator builds context, calls showContextView). */
  setCtrlOHandler: (handler: (() => void) | null) => void;
}

/**
 * Root Ink component for the SB Chat REPL.
 *
 * Uses <Static> for completed messages (written once to terminal scrollback).
 * Only the dock (status | prompt | info) is dynamic (~6 lines).
 */
export const ChatApp = React.forwardRef<ChatAppHandle, ChatAppProps>(function ChatApp(
  {
    agentId,
    timezone,
    infoItems: initialInfoItems,
    fullscreen = false,
    dynamicMessages = false,
    onUserInput,
    onExit,
  },
  ref
) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statusSummary, setStatusSummary] = useState('waiting for input');
  const [waiting, setWaiting] = useState(false);
  const [waitingBackend, setWaitingBackend] = useState('');
  const [infoItems, setInfoItems] = useState(initialInfoItems);
  const [ctrlCCount, setCtrlCCount] = useState(0);
  const [ctrlCTimer, setCtrlCTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const [commandOutput, setCommandOutput] = useState<string[] | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [lastSurfacedMemories, setLastSurfacedMemories] = useState<string[]>([]);

  // Abort handler — set by orchestrator when a backend turn is running
  const abortHandlerRef = useRef<(() => void) | null>(null);

  // Context viewer state
  const [contextViewLines, setContextViewLines] = useState<string[] | null>(null);
  // Brief intermediate state: both views hidden so Ink renders a zero-height
  // frame, erasing the tall context viewer before showing the shorter dock.
  const [dismissingContext, setDismissingContext] = useState(false);

  // Waiting indicator state — verb rotates every 3s
  const [waitingVerb, setWaitingVerb] = useState('');
  const verbIndexRef = useRef(Math.floor(Math.random() * WAITING_VERBS.length));

  useEffect(() => {
    if (!waiting) return;
    verbIndexRef.current = Math.floor(Math.random() * WAITING_VERBS.length);
    setWaitingVerb(WAITING_VERBS[verbIndexRef.current]!);

    const verbTimer = setInterval(() => {
      verbIndexRef.current = (verbIndexRef.current + 1) % WAITING_VERBS.length;
      setWaitingVerb(WAITING_VERBS[verbIndexRef.current]!);
    }, 3000);

    return () => clearInterval(verbTimer);
  }, [waiting]);

  // Expose handle for external state pushing
  React.useImperativeHandle(ref, () => ({
    addMessage: (msg: ChatMessage) => {
      setMessages((prev) => [...prev, msg]);
    },
    setStatusSummary: (summary: string) => {
      setStatusSummary(summary);
    },
    setWaiting: (w: boolean, backend?: string) => {
      setWaiting(w);
      if (backend) setWaitingBackend(backend);
    },
    setInfoItems: (items: string[]) => {
      setInfoItems(items);
    },
    setAbortHandler: (handler: (() => void) | null) => {
      abortHandlerRef.current = handler;
    },
    setCommandOutput: (lines: string[] | null) => {
      setCommandOutput(lines);
    },
    setSurfacedMemories: (lines: string[]) => {
      setLastSurfacedMemories(lines);
    },
    showContextView: (lines: string[]) => {
      setContextViewLines(lines);
    },
    setCtrlOHandler: (handler: (() => void) | null) => {
      ctrlOHandlerRef.current = handler;
    },
  }));

  const handleSubmit = useCallback(
    (value: string) => {
      setInputHistory((prev) => {
        if (prev[prev.length - 1] === value) return prev;
        return [...prev, value];
      });
      onUserInput(value);
    },
    [onUserInput]
  );

  const handleAbort = useCallback(() => {
    if (abortHandlerRef.current) {
      abortHandlerRef.current();
      abortHandlerRef.current = null;
    }
  }, []);

  // Ctrl+O callback — set by orchestrator to build context and call showContextView
  const ctrlOHandlerRef = useRef<(() => void) | null>(null);

  const handleExpandMemories = useCallback(() => {
    if (ctrlOHandlerRef.current) {
      ctrlOHandlerRef.current();
    }
  }, []);

  const [ctrlCHint, setCtrlCHint] = useState(false);

  const handleCtrlC = useCallback(() => {
    if (ctrlCCount >= 1) {
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      onExit();
      exit();
      return;
    }
    setCtrlCCount(1);
    setCtrlCHint(true);
    const timer = setTimeout(() => {
      setCtrlCCount(0);
      setCtrlCHint(false);
    }, 1500);
    setCtrlCTimer(timer);
  }, [ctrlCCount, ctrlCTimer, onExit, exit]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
    };
  }, [ctrlCTimer]);

  const now = formatNow(timezone);
  const promptLabel = '> ';

  const showingContext = contextViewLines !== null;
  const dockVisible = !showingContext && !dismissingContext;

  const handleContextDismiss = useCallback(() => {
    // Two-phase dismiss: hide both views for one frame so Ink renders a
    // zero-height dynamic area (erasing the tall context viewer), then
    // show the dock fresh on the next tick.
    setDismissingContext(true);
    setContextViewLines(null);
    setTimeout(() => setDismissingContext(false), 0);
  }, []);

  const messageElements = messages.map((msg) => (
    <MessageLine
      key={msg.id}
      id={msg.id}
      role={msg.role}
      content={msg.content}
      label={msg.label}
      time={msg.time}
      trailingMeta={msg.trailingMeta}
    />
  ));

  return (
    <Box flexDirection="column">
      {/* Context viewer — always mounted, toggled via display.
          Keeps useInput lifecycle stable across open/close cycles. */}
      <Box display={showingContext ? 'flex' : 'none'} flexDirection="column">
        <ContextViewer
          lines={contextViewLines ?? []}
          isActive={showingContext}
          onDismiss={handleContextDismiss}
        />
      </Box>

      {/* Chat messages — Static writes to scrollback regardless of display */}
      {dockVisible &&
        (dynamicMessages ? (
          <Box flexDirection="column">{messageElements}</Box>
        ) : (
          <Static items={messages}>
            {(msg) => (
              <MessageLine
                key={msg.id}
                id={msg.id}
                role={msg.role}
                content={msg.content}
                label={msg.label}
                time={msg.time}
                trailingMeta={msg.trailingMeta}
              />
            )}
          </Static>
        ))}

      {/* Dock — always mounted, hidden when context viewer is active.
          useInputActive=false yields stdin to ContextViewer's useInput. */}
      <Box display={dockVisible ? 'flex' : 'none'} flexDirection="column">
        <Dock
          statusSummary={statusSummary}
          time={now}
          infoItems={infoItems}
          promptLabel={promptLabel}
          onSubmit={handleSubmit}
          isPromptActive={!waiting}
          useInputActive={dockVisible}
          onAbort={handleAbort}
          commandOutput={commandOutput}
          onCommandOutputClear={() => setCommandOutput(null)}
          inputHistory={inputHistory}
          ctrlCHint={ctrlCHint}
          onCtrlC={handleCtrlC}
          onExpandMemories={handleExpandMemories}
          waitingElement={
            waiting ? (
              <Box paddingX={1}>
                <Text color="cyan">{SPINNER_CHAR + ' '}</Text>
                <Text dimColor>{waitingVerb}...</Text>
              </Box>
            ) : undefined
          }
        />
      </Box>
    </Box>
  );
});

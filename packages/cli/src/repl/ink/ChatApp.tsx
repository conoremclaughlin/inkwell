import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Static, Text, useApp } from 'ink';
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
}

/**
 * Root Ink component for the SB Chat REPL.
 *
 * Uses <Static> for completed messages (written once to terminal scrollback).
 * Only the dock (status | prompt | info) is dynamic (~6 lines).
 */
export const ChatApp = React.forwardRef<ChatAppHandle, ChatAppProps>(function ChatApp(
  { agentId, timezone, infoItems: initialInfoItems, fullscreen = false, onUserInput, onExit },
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

  const handleExpandMemories = useCallback(() => {
    if (lastSurfacedMemories.length > 0) {
      setCommandOutput(commandOutput ? null : lastSurfacedMemories);
    }
  }, [lastSurfacedMemories, commandOutput]);

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

  return (
    <Box flexDirection="column">
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

      <Dock
        statusSummary={statusSummary}
        time={now}
        infoItems={infoItems}
        promptLabel={promptLabel}
        onSubmit={handleSubmit}
        isPromptActive={!waiting}
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
  );
});

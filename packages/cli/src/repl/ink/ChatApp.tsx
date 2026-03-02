import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Static, Text, useApp, useStdout } from 'ink';
import { StatusBar } from './StatusBar.js';
import { InfoBar } from './InfoBar.js';
import { PromptInput } from './PromptInput.js';
import { Separator } from './Separator.js';
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
}

/**
 * Root Ink component for the SB Chat REPL.
 *
 * Uses <Static> for completed messages (written once to terminal scrollback).
 * Only the dock (status | prompt | info) is dynamic (~6 lines).
 * On terminal resize, the Static remount key increments to force a full
 * re-render of all static content at the new width.
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

  // Remount key — incremented on resize to force <Static> to re-render all items
  const [remountKey, setRemountKey] = useState(0);

  // Terminal resize tracking
  const { stdout } = useStdout();
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setRemountKey((k) => k + 1);
      }, 150);
    };
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [stdout]);

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
  }));

  const handleSubmit = useCallback(
    (value: string) => {
      onUserInput(value);
    },
    [onUserInput]
  );

  // Handle Ctrl+C for double-tap exit
  useEffect(() => {
    const handler = () => {
      if (ctrlCCount >= 1) {
        onExit();
        exit();
        return;
      }
      setCtrlCCount(1);
      const timer = setTimeout(() => setCtrlCCount(0), 1500);
      setCtrlCTimer(timer);
    };
    process.on('SIGINT', handler);
    return () => {
      process.off('SIGINT', handler);
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
    };
  }, [ctrlCCount, ctrlCTimer, onExit, exit]);

  const now = formatNow(timezone);
  const promptLabel = '> ';

  return (
    <Box flexDirection="column">
      {/* Messages — written once to terminal scrollback via <Static>.
          key={remountKey} forces full re-render on terminal resize. */}
      <Static key={remountKey} items={messages}>
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

      {/* Dynamic tail: waiting indicator + dock */}
      {waiting && (
        <Box paddingX={1}>
          <Text color="cyan">{SPINNER_CHAR + ' '}</Text>
          <Text dimColor>{waitingVerb}...</Text>
        </Box>
      )}

      <Separator />
      <StatusBar summary={statusSummary} time={now} />
      <Separator />
      <PromptInput label={promptLabel} onSubmit={handleSubmit} isActive={!waiting} />
      <Separator />
      <InfoBar items={infoItems} />
    </Box>
  );
});

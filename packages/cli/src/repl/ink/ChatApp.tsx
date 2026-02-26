import React, { useState, useCallback, useEffect } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { StatusBar } from './StatusBar.js';
import { InfoBar } from './InfoBar.js';
import { PromptInput } from './PromptInput.js';
import { Separator } from './Separator.js';
import { MessageLine, type MessageLineProps } from './MessageLine.js';
import { formatNow } from '../tui-components.js';

export interface ChatMessage extends MessageLineProps {
  id: string;
}

export interface ChatAppProps {
  agentId: string;
  timezone?: string;
  infoItems: string[];
  /** Called when the user submits a message from the prompt. */
  onUserInput: (raw: string) => void;
  /** Called when the user requests exit (double Ctrl+C). */
  onExit: () => void;
}

/**
 * External handle for pushing state into the ChatApp from outside React.
 * The chat command orchestrator calls these to push messages, update status, etc.
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
 * Layout:
 *   <Static> — chat messages (committed to scrollback, never re-render)
 *   ─────────── separator
 *   status bar                          timestamp
 *   ─────────── separator
 *   prompt> _
 *   ─────────── separator
 *   info bar
 */
export const ChatApp = React.forwardRef<ChatAppHandle, ChatAppProps>(
  function ChatApp({ agentId, timezone, infoItems: initialInfoItems, onUserInput, onExit }, ref) {
    const { exit } = useApp();
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [statusSummary, setStatusSummary] = useState('waiting for input');
    const [waiting, setWaiting] = useState(false);
    const [waitingBackend, setWaitingBackend] = useState('');
    const [infoItems, setInfoItems] = useState(initialInfoItems);
    const [ctrlCCount, setCtrlCCount] = useState(0);
    const [ctrlCTimer, setCtrlCTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

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
    const promptLabel = `${agentId}> `;

    return (
      <Box flexDirection="column">
        {/* Messages scroll into scrollback — <Static> renders once and commits */}
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

        {/* Waiting indicator */}
        {waiting && (
          <Box paddingX={1}>
            <Text color="cyan">{'✦ '}</Text>
            <Text dimColor>
              Waiting for {waitingBackend || 'backend'}...
            </Text>
          </Box>
        )}

        {/* Fixed dock: status | prompt | info */}
        <Separator />
        <StatusBar summary={statusSummary} time={now} />
        <Separator />
        <PromptInput label={promptLabel} onSubmit={handleSubmit} isActive={!waiting} />
        <Separator />
        <InfoBar items={infoItems} />
      </Box>
    );
  }
);

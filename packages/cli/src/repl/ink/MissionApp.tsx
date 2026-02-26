import React, { useState, useEffect, useRef } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import { Separator } from './Separator.js';
import { formatNow } from '../tui-components.js';

// ── Feed event types ──

export type FeedEventType = 'inbox' | 'activity' | 'task' | 'document' | 'session' | 'system';

export interface FeedEvent {
  id: string;
  type: FeedEventType;
  agent?: string;
  content: string;
  time: string;
  detail?: string;
}

// ── SB summary row ──

export interface AgentSummary {
  agent: string;
  status: string;
  unread: number;
  sessions: number;
  latestThread?: string;
}

// ── Component props + handle ──

export interface MissionAppProps {
  timezone?: string;
  onExit: () => void;
}

export interface MissionAppHandle {
  addEvent: (event: FeedEvent) => void;
  setAgents: (agents: AgentSummary[]) => void;
  setStatus: (status: string) => void;
}

// ── Styling ──

const TYPE_COLORS: Record<FeedEventType, string> = {
  inbox: 'cyan',
  activity: 'magenta',
  task: 'yellow',
  document: 'blue',
  session: 'green',
  system: 'gray',
};

const TYPE_ICONS: Record<FeedEventType, string> = {
  inbox: '📬',
  activity: '⚡',
  task: '✓',
  document: '📄',
  session: '🔄',
  system: '•',
};

/** Live mission control feed — renders events as scrollback with agent summary dock. */
export const MissionApp = React.forwardRef<MissionAppHandle, MissionAppProps>(
  function MissionApp({ timezone, onExit }, ref) {
    const { exit } = useApp();
    const [events, setEvents] = useState<FeedEvent[]>([]);
    const [agents, setAgents] = useState<AgentSummary[]>([]);
    const [status, setStatus] = useState('initializing...');
    const [ctrlCCount, setCtrlCCount] = useState(0);
    const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useImperativeHandle(ref, () => ({
      addEvent: (event: FeedEvent) => {
        setEvents((prev) => [...prev, event]);
      },
      setAgents: (a: AgentSummary[]) => {
        setAgents(a);
      },
      setStatus: (s: string) => {
        setStatus(s);
      },
    }));

    // Double Ctrl+C to exit
    useEffect(() => {
      const handler = () => {
        if (ctrlCCount >= 1) {
          onExit();
          exit();
          return;
        }
        setCtrlCCount(1);
        ctrlCTimerRef.current = setTimeout(() => setCtrlCCount(0), 1500);
      };
      process.on('SIGINT', handler);
      return () => {
        process.off('SIGINT', handler);
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
      };
    }, [ctrlCCount, onExit, exit]);

    const now = formatNow(timezone);

    return (
      <Box flexDirection="column">
        {/* Feed events scroll into scrollback */}
        <Static items={events}>
          {(event) => (
            <Box key={event.id} paddingLeft={1} marginTop={event.type === 'system' ? 0 : 1}>
              <Text color={TYPE_COLORS[event.type] || 'gray'}>
                {TYPE_ICONS[event.type] || '•'}{' '}
              </Text>
              <Box flexDirection="column" flexShrink={1}>
                <Box>
                  {event.agent && (
                    <Text bold color={TYPE_COLORS[event.type] || 'gray'}>
                      {event.agent}
                    </Text>
                  )}
                  {event.agent && <Text>{'  '}</Text>}
                  <Text dimColor>{event.time}</Text>
                </Box>
                <Box paddingLeft={event.agent ? 2 : 0}>
                  <Text wrap="wrap">{event.content}</Text>
                </Box>
                {event.detail && (
                  <Box paddingLeft={event.agent ? 2 : 0}>
                    <Text dimColor wrap="wrap">{event.detail}</Text>
                  </Box>
                )}
              </Box>
            </Box>
          )}
        </Static>

        {/* Fixed dock: SB summary + status */}
        <Separator />
        <Box paddingX={1} flexDirection="column">
          {agents.length > 0 ? (
            agents.map((a) => (
              <Box key={a.agent} gap={2}>
                <Text bold color="cyan">{a.agent.padEnd(8)}</Text>
                <Text dimColor>{a.status.padEnd(14)}</Text>
                <Text>{a.sessions} session{a.sessions !== 1 ? 's' : ''}</Text>
                {a.unread > 0 && <Text color="yellow">{a.unread} unread</Text>}
                {a.latestThread && <Text dimColor>{a.latestThread}</Text>}
              </Box>
            ))
          ) : (
            <Text dimColor>Loading SBs...</Text>
          )}
        </Box>
        <Separator />
        <Box justifyContent="space-between" paddingX={1}>
          <Text dimColor>{status}</Text>
          <Text dimColor>{now}</Text>
        </Box>
        <Separator />
        <Box paddingX={1}>
          <Text dimColor>ctrl+c x2 quit  ·  SB Mission Control</Text>
        </Box>
      </Box>
    );
  }
);

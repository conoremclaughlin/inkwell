import React, { useState, useEffect, useRef } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
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
  phase?: string;
  unread: number;
  sessions: number;
  /** Breakdown of session counts by lifecycle state, e.g. { running: 2, idle: 1 } */
  sessionsByLifecycle?: Record<string, number>;
  /** Count of sessions actively generating (running + fresh updated_at) */
  generating?: number;
  /** Count of sessions started in last 24h */
  sessionsToday?: number;
  /** Count of distinct studios/workspaces */
  studioCount?: number;
  latestThread?: string;
}

// ── Component props + handle ──

export interface MissionAppProps {
  timezone?: string;
  fullscreen?: boolean;
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

/**
 * Single feed event rendered as a proper React component for <Static>.
 * Uses Box/Text layout so Ink handles wrapping at the current terminal width.
 */
/** Max lines shown for detail when collapsed. */
const DETAIL_COLLAPSED_LINES = 3;

export function collapseDetail(detail: string, maxLines: number, cols: number = 80): string {
  const availableWidth = Math.max(1, cols - 4); // paddingLeft is always 4 for inbox
  const lines = detail.split('\n');
  const kept: string[] = [];
  let visualRows = 0;
  for (const line of lines) {
    const rows = line.length === 0 ? 1 : Math.ceil(line.length / availableWidth);
    if (visualRows + rows > maxLines) {
      const remaining = maxLines - visualRows;
      if (remaining > 0) kept.push(line.slice(0, remaining * availableWidth));
      return kept.join('\n') + '…';
    }
    kept.push(line);
    visualRows += rows;
  }
  return detail;
}

export function estimateRows(text: string, cols: number): number {
  const width = Math.max(1, cols);
  return text.split('\n').reduce((sum, line) => {
    return sum + (line.length === 0 ? 1 : Math.ceil(line.length / width));
  }, 0);
}

const FeedEventLine = React.memo(function FeedEventLine({
  type,
  agent,
  content,
  time,
  detail,
  detailExpanded,
  cols,
}: Omit<FeedEvent, 'id'> & { detailExpanded?: boolean; cols?: number }) {
  const color = TYPE_COLORS[type] || 'gray';
  const icon = TYPE_ICONS[type] || '•';
  const renderedDetail =
    detail && !detailExpanded ? collapseDetail(detail, DETAIL_COLLAPSED_LINES, cols) : detail;

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={type !== 'system' ? 1 : 0}>
      {/* Header: icon + agent + time */}
      <Box>
        <Text color={color}>{icon} </Text>
        {agent ? (
          <>
            <Text bold color={color}>
              {agent}
            </Text>
            <Text>{'  '}</Text>
          </>
        ) : null}
        <Text dimColor>{time}</Text>
      </Box>
      {/* Content */}
      <Box paddingLeft={agent ? 4 : 2}>
        <Text wrap="wrap">{content}</Text>
      </Box>
      {/* Optional detail */}
      {renderedDetail ? (
        <Box paddingLeft={agent ? 4 : 2}>
          <Text dimColor wrap="wrap">
            {renderedDetail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

/**
 * Live mission control feed.
 *
 * Uses <Static> for all events (written once to terminal scrollback).
 * Only the dock (agent summary + status + info) is dynamic.
 * This bounds cursor movement to the dock height, preventing scroll snapback.
 */
export const MissionApp = React.forwardRef<MissionAppHandle, MissionAppProps>(function MissionApp(
  { timezone, fullscreen = false, onExit },
  ref
) {
  const { exit } = useApp();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [status, setStatus] = useState('initializing...');
  const [ctrlCCount, setCtrlCCount] = useState(0);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [detailExpanded, setDetailExpanded] = useState(false);

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

  // Terminal dimensions + remount key for <Static> resize re-render
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns || 80);
  const [remountKey, setRemountKey] = useState(0);
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      setCols(stdout?.columns || 80);
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

  // Ctrl+O to toggle detail expansion (re-renders all feed events)
  useInput((_input, key) => {
    if (key.ctrl && _input === 'o') {
      setDetailExpanded((prev) => !prev);
      setRemountKey((k) => k + 1);
    }
  });

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

  // Truncate helpers
  const pad = 2;
  const truncLine = (text: string) => {
    const max = cols - pad;
    return text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text;
  };
  const truncStatus = (() => {
    const gap = 2;
    const maxStatus = cols - pad - now.length - gap;
    return maxStatus > 0 && status.length > maxStatus
      ? status.slice(0, Math.max(1, maxStatus - 1)) + '…'
      : status;
  })();

  return (
    <Box flexDirection="column">
      {/* Events — written once to terminal scrollback via <Static>.
          key={remountKey} forces full re-render on terminal resize. */}
      <Static key={remountKey} items={events}>
        {(event) => (
          <FeedEventLine
            key={event.id}
            type={event.type}
            agent={event.agent}
            content={event.content}
            time={event.time}
            detail={event.detail}
            detailExpanded={detailExpanded}
            cols={cols}
          />
        )}
      </Static>

      {/* Dynamic dock only */}
      <Separator />
      <Box paddingX={1} flexDirection="column">
        {agents.length > 0 ? (
          agents.map((a) => {
            // Build compact status: "⚡ N generating · 🔄 M compacting · N today · K studios"
            const parts: string[] = [];
            const gen = a.generating ?? 0;
            const compacting = a.sessionsByLifecycle?.['compacting'] ?? 0;
            if (gen > 0 && compacting > 0) {
              parts.push(`⚡ ${gen} generating · 🔄 ${compacting} compacting`);
            } else if (gen > 0) {
              parts.push(`⚡ ${gen} generating`);
            } else if (compacting > 0) {
              parts.push(`🔄 ${compacting} compacting`);
            } else {
              parts.push('0 generating');
            }
            const today = a.sessionsToday ?? 0;
            parts.push(`${today} today`);
            const studios = a.studioCount ?? 0;
            if (studios > 0) {
              parts.push(`${studios} studio${studios !== 1 ? 's' : ''}`);
            }
            if (a.unread > 0) {
              parts.push(`${a.unread} unread`);
            }
            const sessionLabel = parts.join(' · ');

            const line = [a.agent.padEnd(8), sessionLabel, a.latestThread || '']
              .filter(Boolean)
              .join('  ');
            return (
              <Box key={a.agent}>
                <Text wrap="truncate">{truncLine(line)}</Text>
              </Box>
            );
          })
        ) : (
          <Text dimColor>Loading SBs...</Text>
        )}
      </Box>
      <Separator />
      <Box justifyContent="space-between" paddingX={1}>
        <Text dimColor wrap="truncate">
          {truncStatus}
        </Text>
        <Text dimColor>{now}</Text>
      </Box>
      <Separator />
      <Box paddingX={1}>
        <Text dimColor wrap="truncate">
          {truncLine(
            `ctrl+c x2 quit  ·  ctrl+o ${detailExpanded ? 'collapse' : 'expand'} details  ·  SB Mission Control`
          )}
        </Text>
      </Box>
    </Box>
  );
});

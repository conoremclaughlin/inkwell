import React from 'react';
import { Box, Text } from 'ink';

export type MessageRole = 'user' | 'assistant' | 'inbox' | 'activity' | 'system';

export interface MessageLineProps {
  id: string;
  role: MessageRole;
  content: string;
  label?: string;
  time?: string;
  trailingMeta?: string;
}

const ROLE_COLORS: Record<MessageRole, string> = {
  user: 'green',
  assistant: 'white',
  inbox: 'cyan',
  activity: 'magenta',
  system: 'gray',
};

/** Single chat message with label, content, and trailing metadata. */
export function MessageLine({
  role,
  content,
  label,
  time,
  trailingMeta,
}: MessageLineProps): React.ReactElement {
  const displayLabel = label || role;
  const color = ROLE_COLORS[role] || 'gray';
  const meta = [time, trailingMeta].filter(Boolean).join('  ·  ');

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {/* Header: label + metadata on one line */}
      <Box>
        <Text bold color={color}>{displayLabel}</Text>
        {meta ? (
          <>
            <Text>{'  '}</Text>
            <Text dimColor>{meta}</Text>
          </>
        ) : null}
      </Box>
      {/* Content: small indent from label, wraps naturally */}
      <Box paddingLeft={2}>
        <Text color={color} wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}

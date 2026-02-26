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

/** Single chat message: "  label  content                timestamp" */
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
    <Box justifyContent="space-between">
      <Box>
        <Text>{'  '}</Text>
        <Text bold color={color}>
          {displayLabel}
        </Text>
        <Text>{'  '}</Text>
        <Text color={color}>{content}</Text>
      </Box>
      {meta ? <Text dimColor>{meta}</Text> : null}
    </Box>
  );
}

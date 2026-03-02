import React from 'react';
import { Box, Text } from 'ink';

export type MessageRole = 'user' | 'assistant' | 'inbox' | 'activity' | 'system' | 'grant';

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
  grant: 'greenBright',
};

/**
 * Collapse image file paths to numbered [Image #N] tokens.
 * Matches absolute paths and file:// URIs ending in common image extensions.
 * Path segments use non-greedy matching and stop at whitespace boundaries.
 */
const IMAGE_PATH_RE =
  /(?:file:\/\/)?\/(?:[^\s/]+\/)*[^\s/]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|tiff|heic)\b/gi;

export function collapseImagePaths(text: string): string {
  let counter = 0;
  return text.replace(IMAGE_PATH_RE, () => {
    counter += 1;
    return `[Image #${counter}]`;
  });
}

/** Single chat message with label, content, and trailing metadata. */
export const MessageLine = React.memo(function MessageLine({
  role,
  content,
  label,
  time,
  trailingMeta,
}: MessageLineProps): React.ReactElement {
  const displayLabel = label || role;
  const color = ROLE_COLORS[role] || 'gray';
  const meta = [time, trailingMeta].filter(Boolean).join('  ·  ');
  const displayContent = collapseImagePaths(content);

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      {/* Header: label + metadata on one line */}
      <Box>
        <Text bold color={color}>
          {displayLabel}
        </Text>
        {meta ? (
          <>
            <Text>{'  '}</Text>
            <Text dimColor>{meta}</Text>
          </>
        ) : null}
      </Box>
      {/* Content: small indent from label, wraps naturally */}
      <Box paddingLeft={2}>
        <Text color={color} wrap="wrap">
          {displayContent}
        </Text>
      </Box>
    </Box>
  );
});

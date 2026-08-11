import React from 'react';
import { Box, Text } from 'ink';

export type MessageRole =
  | 'user'
  | 'assistant'
  | 'inbox'
  | 'activity'
  | 'system'
  | 'grant'
  | 'event';

export interface MessageLineProps {
  id: string;
  role: MessageRole;
  content: string;
  label?: string;
  time?: string;
  trailingMeta?: string;
  /**
   * Continuation of the previous message (streamed paragraph after the
   * first): renders content only, no label row.
   */
  continuation?: boolean;
}

const LABEL_COLORS: Record<MessageRole, string> = {
  user: 'greenBright',
  assistant: 'blueBright',
  inbox: 'cyan',
  activity: 'magenta',
  system: 'gray',
  grant: 'green',
  event: 'gray',
};

const CONTENT_COLORS: Record<MessageRole, string | undefined> = {
  user: undefined,
  assistant: undefined,
  inbox: undefined,
  activity: undefined,
  system: 'gray',
  grant: 'green',
  event: 'gray',
};

/**
 * Strip leading indentation from event content, including spaces that hide
 * BEHIND leading ANSI color sequences — live call sites wrap their strings
 * in chalk (e.g. chalk.dim('  🗑 …')), so the first bytes are SGR escapes
 * and a plain trimStart() never reaches the embedded spaces. The event
 * role's paddingLeft owns the column; content must not add to it.
 */
// eslint-disable-next-line no-control-regex
const LEADING_INDENT_RE = /^((?:\u001b\[[0-9;]*m)*)[ \t]+/;

export function normalizeEventContent(content: string): string {
  return content.replace(LEADING_INDENT_RE, '$1');
}

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
  continuation,
}: MessageLineProps): React.ReactElement {
  const displayLabel = label || role;
  const labelColor = LABEL_COLORS[role] || 'gray';
  const contentColor = CONTENT_COLORS[role];
  const meta = [time, trailingMeta].filter(Boolean).join('  ·  ');
  const displayContent = collapseImagePaths(content);

  // Events are compact progress/status lines (tool runs, signals, dividers):
  // a single dim line at the content column — no label row, no spacing.
  // normalizeEventContent strips call-site indentation (even behind chalk's
  // leading ANSI escapes) so every event row aligns flush with message
  // content (column 3), and truncate-end keeps them to ONE line with a
  // terminal-width ellipsis — full details live in the inspector (Ctrl+T).
  if (role === 'event') {
    return (
      <Box paddingLeft={3}>
        <Text dimColor wrap="truncate-end">
          {normalizeEventContent(displayContent)}
          {meta ? `  ·  ${meta}` : ''}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={1}>
      {/* Label is padded to sit flush with the content text below it.
          Continuations (streamed paragraphs after the first) skip it. */}
      {!continuation && (
        <Box paddingLeft={2}>
          <Text bold color={labelColor}>
            {displayLabel}
          </Text>
          {meta ? (
            <>
              <Text>{'  '}</Text>
              <Text dimColor>{meta}</Text>
            </>
          ) : null}
        </Box>
      )}
      <Box paddingLeft={2}>
        <Text color={contentColor} wrap="wrap">
          {displayContent}
        </Text>
      </Box>
    </Box>
  );
});

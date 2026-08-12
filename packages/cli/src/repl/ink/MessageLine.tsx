import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';

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

/**
 * Width of the leftmost gutter column. Markers (role glyphs, label emoji)
 * render inside it; ALL text — headings, message bodies, event lines — starts
 * at this column so it lines up with the prompt input text, whose label
 * (`❯` + two spaces) occupies the same gutter.
 */
export const GUTTER_WIDTH = 3;

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
 * Center a marker glyph within the gutter column: single-width glyphs
 * (❯ ✦ ∗ ✓) sit in the middle column instead of hugging the left edge, while
 * double-width emoji (📬 ⚡) keep their natural left position — a 2-col glyph
 * already fills the 3-col gutter visually. Width is measured with the same
 * string-width ink itself uses, so the pad never disagrees with layout.
 */
export function centerGutterMarker(marker: string): string {
  if (!marker) return marker;
  const pad = Math.max(0, Math.floor((GUTTER_WIDTH - stringWidth(marker)) / 2));
  return ' '.repeat(pad) + marker;
}

/** Gutter glyph per role, used when the label carries no emoji of its own. */
const ROLE_MARKERS: Record<MessageRole, string> = {
  user: '❯',
  assistant: '✦',
  inbox: '✉',
  activity: '⚡',
  system: '∗',
  grant: '✓',
  event: '',
};

/**
 * Strip leading indentation from event content, including spaces that hide
 * BEHIND leading ANSI color sequences — live call sites wrap their strings
 * in chalk (e.g. chalk.dim('  🗑 …')), so the first bytes are SGR escapes
 * and a plain trimStart() never reaches the embedded spaces. The event
 * role's gutter owns the column; content must not add to it.
 */
// eslint-disable-next-line no-control-regex
const LEADING_INDENT_RE = /^((?:\u001b\[[0-9;]*m)*)[ \t]+/;

export function normalizeEventContent(content: string): string {
  return content.replace(LEADING_INDENT_RE, '$1');
}

/**
 * A leading marker is a short cluster of symbol characters (emoji like 🛠 ⚡ 🗑,
 * glyphs like ✅) followed by whitespace or end-of-string, optionally behind
 * chalk's ANSI prefix. Box-drawing characters and dashes are excluded so
 * divider lines (`─── ⌃ out of context ───`) stay intact.
 */
// eslint-disable-next-line no-control-regex
const LEADING_MARKER_RE = /^((?:\u001b\[[0-9;]*m)*)([^\sA-Za-z0-9\u001b─-╿—–-]{1,4})(?:[ \t]+|$)/;

/**
 * Split a leading marker glyph off a label or event line so it can render in
 * the gutter column while the text stays at the content column. Returns the
 * original string as `rest` (marker empty) when there is no marker.
 */
export function splitLeadingMarker(text: string): { marker: string; rest: string } {
  const match = LEADING_MARKER_RE.exec(text);
  if (!match) return { marker: '', rest: text };
  return { marker: match[2]!, rest: match[1]! + text.slice(match[0].length) };
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

/** Single chat message with gutter marker, label row, content, and metadata. */
export const MessageLine = React.memo(function MessageLine({
  role,
  content,
  label,
  time,
  trailingMeta,
  continuation,
}: MessageLineProps): React.ReactElement {
  const labelColor = LABEL_COLORS[role] || 'gray';
  const contentColor = CONTENT_COLORS[role];
  const meta = [time, trailingMeta].filter(Boolean).join('  ·  ');
  const displayContent = collapseImagePaths(content);

  // Events are compact progress/status lines (tool runs, signals, dividers):
  // a single dim line — marker in the gutter, text at the content column —
  // truncated to ONE line with a terminal-width ellipsis. Full details live
  // in the inspector (Ctrl+T).
  if (role === 'event') {
    const { marker, rest } = splitLeadingMarker(normalizeEventContent(displayContent));
    return (
      <Box>
        <Box width={GUTTER_WIDTH} flexShrink={0}>
          <Text dimColor>{centerGutterMarker(marker)}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {rest}
          {meta ? `  ·  ${meta}` : ''}
        </Text>
      </Box>
    );
  }

  // Labels may carry their own marker emoji ('📬 inbox', '🔐 permission');
  // it moves to the gutter and the text stays as the heading. A label that is
  // ONLY a marker ('⚡') falls back to the role name for its heading.
  const { marker: labelMarker, rest: labelRest } = splitLeadingMarker(label || '');
  const marker = labelMarker || ROLE_MARKERS[role] || '';
  const heading = labelRest.trim() || role;

  return (
    <Box marginTop={1}>
      <Box width={GUTTER_WIDTH} flexShrink={0}>
        {!continuation && marker ? (
          <Text color={labelColor}>{centerGutterMarker(marker)}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {/* Continuations (streamed paragraphs after the first) skip the
            label row; the blank row below it gives the heading room to
            breathe before the body text. */}
        {!continuation && (
          <Box marginBottom={1}>
            <Text bold color={labelColor}>
              {heading}
            </Text>
            {meta ? (
              <>
                <Text>{'  '}</Text>
                <Text dimColor>{meta}</Text>
              </>
            ) : null}
          </Box>
        )}
        <Text color={contentColor} wrap="wrap">
          {displayContent}
        </Text>
      </Box>
    </Box>
  );
});

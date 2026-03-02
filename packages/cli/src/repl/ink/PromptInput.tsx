import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

interface PromptInputProps {
  label: string;
  onSubmit: (value: string) => void;
  isActive?: boolean;
  /** Scroll callback for page up/down from within the prompt. */
  onScroll?: (direction: 'up' | 'down') => void;
}

/** Find the position of the previous word boundary (start of current/previous word). */
function prevWordBoundary(text: string, pos: number): number {
  let i = pos;
  // Skip any whitespace immediately before cursor
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  // Skip non-whitespace (the word itself)
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

/** Find the position of the next word boundary (end of current/next word). */
function nextWordBoundary(text: string, pos: number): number {
  let i = pos;
  // Skip non-whitespace (the word itself)
  while (i < text.length && !/\s/.test(text[i]!)) i++;
  // Skip any whitespace after the word
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

/**
 * REPL prompt with line editing.
 * Supports: typing, backspace, enter, cursor movement, word-level navigation.
 */
export function PromptInput({
  label,
  onSubmit,
  isActive = true,
  onScroll,
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    // Allow typing while waiting — only block submission
    if (key.return) {
      if (!isActive) return; // Can't submit while agent is responding
      const submitted = value.trim();
      setValue('');
      setCursor(0);
      if (submitted) {
        onSubmit(submitted);
      }
      return;
    }

    // Option+Backspace: delete word before cursor
    if ((key.backspace || key.delete) && key.meta) {
      const boundary = prevWordBoundary(value, cursor);
      setValue((prev) => prev.slice(0, boundary) + prev.slice(cursor));
      setCursor(boundary);
      return;
    }

    // Regular backspace: delete one character
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue((prev) => prev.slice(0, cursor - 1) + prev.slice(cursor));
        setCursor((prev) => prev - 1);
      }
      return;
    }

    // Ctrl+C is handled by Ink at the app level
    if (key.ctrl && input === 'c') return;

    // Ctrl+U: clear line
    if (key.ctrl && input === 'u') {
      setValue('');
      setCursor(0);
      return;
    }

    // Ctrl+W: delete word before cursor (Unix convention)
    if (key.ctrl && input === 'w') {
      const boundary = prevWordBoundary(value, cursor);
      setValue((prev) => prev.slice(0, boundary) + prev.slice(cursor));
      setCursor(boundary);
      return;
    }

    // Ctrl+A: beginning of line
    if (key.ctrl && input === 'a') {
      setCursor(0);
      return;
    }

    // Ctrl+E: end of line
    if (key.ctrl && input === 'e') {
      setCursor(value.length);
      return;
    }

    // Ctrl+K: kill to end of line
    if (key.ctrl && input === 'k') {
      setValue((prev) => prev.slice(0, cursor));
      return;
    }

    // Option+Left: move to previous word boundary
    if (key.leftArrow && key.meta) {
      setCursor((prev) => prevWordBoundary(value, prev));
      return;
    }

    // Option+Right: move to next word boundary
    if (key.rightArrow && key.meta) {
      setCursor((prev) => nextWordBoundary(value, prev));
      return;
    }

    // Regular left/right arrow
    if (key.leftArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((prev) => Math.min(value.length, prev + 1));
      return;
    }

    // Shift+Up/Down: scroll messages (page up/down)
    if (key.shift && key.upArrow) {
      onScroll?.('up');
      return;
    }
    if (key.shift && key.downArrow) {
      onScroll?.('down');
      return;
    }

    // Ignore other control sequences
    if (key.ctrl || key.escape) return;
    if (key.upArrow || key.downArrow) return;
    if (key.tab) return;

    // Regular character input
    if (input) {
      setValue((prev) => prev.slice(0, cursor) + input + prev.slice(cursor));
      setCursor((prev) => prev + input.length);
    }
  }, {});

  // Render the prompt with a visible cursor
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] || ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box paddingX={1}>
      <Text wrap="wrap">
        <Text bold color="green">
          {label}
        </Text>
        {before}
        <Text inverse>{cursorChar}</Text>
        {after}
      </Text>
    </Box>
  );
}

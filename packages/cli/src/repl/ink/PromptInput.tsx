import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

interface PromptInputProps {
  label: string;
  onSubmit: (value: string) => void;
  isActive?: boolean;
}

/**
 * REPL prompt with line editing.
 * Handles: typing, backspace, enter to submit, cursor movement (home/end).
 * History (up/down arrow) can be added later.
 */
export function PromptInput({
  label,
  onSubmit,
  isActive = true,
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  useInput(
    (input, key) => {
      if (!isActive) return;

      if (key.return) {
        const submitted = value.trim();
        setValue('');
        setCursor(0);
        if (submitted) {
          onSubmit(submitted);
        }
        return;
      }

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

      // Ctrl+A / Home: beginning of line
      if ((key.ctrl && input === 'a') || key.meta) {
        setCursor(0);
        return;
      }

      // Ctrl+E / End: end of line
      if (key.ctrl && input === 'e') {
        setCursor(value.length);
        return;
      }

      if (key.leftArrow) {
        setCursor((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.rightArrow) {
        setCursor((prev) => Math.min(value.length, prev + 1));
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
    },
    { isActive }
  );

  // Render the prompt with a visible cursor
  const before = value.slice(0, cursor);
  const cursorChar = value[cursor] || ' ';
  const after = value.slice(cursor + 1);

  return (
    <Box paddingX={1}>
      <Text bold color="green">
        {label}
      </Text>
      <Text>{before}</Text>
      <Text inverse>{cursorChar}</Text>
      <Text>{after}</Text>
    </Box>
  );
}

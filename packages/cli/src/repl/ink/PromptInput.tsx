import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface PromptInputProps {
  label: string;
  onSubmit: (value: string) => void;
  isActive?: boolean;
  /** Called when Escape is pressed while waiting (not active). */
  onAbort?: () => void;
  /** Called when Escape is pressed with empty input (e.g. dismiss dock panel). */
  onEscape?: () => void;
  /** Called when Ctrl+C is pressed. */
  onCtrlC?: () => void;
  /** Called on every keystroke with the current input value. */
  onInputChange?: (value: string) => void;
  /** Scroll callback for page up/down from within the prompt. */
  onScroll?: (direction: 'up' | 'down') => void;
  /** Input history for up/down arrow recall. */
  history?: string[];
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
  onAbort,
  onEscape,
  onCtrlC,
  onInputChange,
  onScroll,
  history = [],
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState('');

  useEffect(() => {
    onInputChange?.(value);
  }, [value, onInputChange]);

  useInput((input, key) => {
    if (key.return) {
      const submitted = value.trim();
      if (!submitted) return;
      setValue('');
      setCursor(0);
      setHistoryIndex(-1);
      setSavedInput('');
      onSubmit(submitted);
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

    if (key.ctrl && input === 'c') {
      onCtrlC?.();
      return;
    }

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

    // Option+Left / Meta+b: move to previous word boundary
    if ((key.leftArrow && key.meta) || (key.meta && input === 'b')) {
      setCursor((prev) => prevWordBoundary(value, prev));
      return;
    }

    // Option+Right / Meta+f: move to next word boundary
    if ((key.rightArrow && key.meta) || (key.meta && input === 'f')) {
      setCursor((prev) => nextWordBoundary(value, prev));
      return;
    }

    // Meta+d: delete word forward
    if (key.meta && input === 'd') {
      const boundary = nextWordBoundary(value, cursor);
      setValue((prev) => prev.slice(0, cursor) + prev.slice(boundary));
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

    // macOS Option+key without "Option as Meta" produces Unicode chars
    if (input === '∫') {
      // Option+b → word left
      setCursor((prev) => prevWordBoundary(value, prev));
      return;
    }
    if (input === 'ƒ') {
      // Option+f → word right
      setCursor((prev) => nextWordBoundary(value, prev));
      return;
    }
    if (input === '∂') {
      // Option+d → delete word forward
      const boundary = nextWordBoundary(value, cursor);
      setValue((prev) => prev.slice(0, cursor) + prev.slice(boundary));
      return;
    }

    // Escape: abort current turn if waiting, clear input if typing, dismiss panel if empty
    if (key.escape) {
      if (!isActive && onAbort) {
        onAbort();
      } else if (value.length > 0) {
        setValue('');
        setCursor(0);
        setHistoryIndex(-1);
        setSavedInput('');
      } else {
        onEscape?.();
      }
      return;
    }

    // Up arrow: navigate input history (most recent first)
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIndex === -1) {
        setSavedInput(value);
        const newIndex = history.length - 1;
        setHistoryIndex(newIndex);
        setValue(history[newIndex]!);
        setCursor(history[newIndex]!.length);
      } else if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setValue(history[newIndex]!);
        setCursor(history[newIndex]!.length);
      }
      return;
    }

    // Down arrow: navigate forward in history, restore saved input at end
    if (key.downArrow) {
      if (historyIndex === -1) return;
      if (historyIndex < history.length - 1) {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setValue(history[newIndex]!);
        setCursor(history[newIndex]!.length);
      } else {
        setHistoryIndex(-1);
        setValue(savedInput);
        setCursor(savedInput.length);
      }
      return;
    }

    // Ignore other control sequences
    if (key.ctrl) return;
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

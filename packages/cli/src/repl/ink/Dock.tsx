import React, { useState, useEffect, useCallback } from 'react';
import { Box, useStdout } from 'ink';
import { StatusBar } from './StatusBar.js';
import { InfoBar } from './InfoBar.js';
import { PromptInput } from './PromptInput.js';
import { Separator } from './Separator.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';

interface DockProps {
  statusSummary: string;
  time: string;
  infoItems: string[];
  promptLabel: string;
  onSubmit: (value: string) => void;
  isPromptActive: boolean;
  onAbort?: () => void;
  waitingElement?: React.ReactNode;
}

/**
 * The dock is the dynamic tail of the chat UI: separators + status + prompt + info.
 *
 * It owns a single resize listener that bumps a React state counter,
 * forcing all children (Separator, StatusBar, etc.) to re-render with
 * the updated stdout.columns. Without this, Ink's resize handler
 * recalculates Yoga layout but does NOT trigger React reconciliation —
 * text content (like separator width) stays stale at the old width.
 */
export function Dock({
  statusSummary,
  time,
  infoItems,
  promptLabel,
  onSubmit,
  isPromptActive,
  onAbort,
  waitingElement,
}: DockProps): React.ReactElement {
  const { stdout } = useStdout();
  const [, setResizeCounter] = useState(0);
  const [inputValue, setInputValue] = useState('');

  useEffect(() => {
    const onResize = () => setResizeCounter((c) => c + 1);
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
  }, []);

  const showAutocomplete = inputValue.startsWith('/');

  return (
    <Box flexDirection="column">
      {waitingElement}
      <Separator />
      <StatusBar summary={statusSummary} time={time} />
      <Separator />
      <PromptInput
        label={promptLabel}
        onSubmit={onSubmit}
        isActive={isPromptActive}
        onAbort={onAbort}
        onInputChange={handleInputChange}
      />
      {showAutocomplete && <SlashAutocomplete input={inputValue} />}
      <Separator />
      <InfoBar items={infoItems} />
    </Box>
  );
}

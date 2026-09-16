import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
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
  /** When false, PromptInput's useInput unsubscribes from stdin entirely
   *  (e.g. when ContextViewer is active and needs exclusive key handling). */
  useInputActive?: boolean;
  onAbort?: () => void;
  commandOutput?: string[] | null;
  onCommandOutputClear?: () => void;
  waitingElement?: React.ReactNode;
  inputHistory?: string[];
  ctrlCHint?: boolean;
  onCtrlC?: () => void;
  onExpandMemories?: () => void;
  onShowToolCalls?: () => void;
}

/**
 * The dock is the dynamic tail of the chat UI: separator + prompt + info bar.
 * Context accounting, queue state, and the clock live in the bottom InfoBar
 * next to cwd/branch — one consolidated chrome line instead of a dedicated
 * status row above the prompt.
 *
 * The SINGLE resize listener lives in ChatApp (it also re-measures the
 * <Static> width there); the Dock re-renders as its child, so sub-components
 * (Separator, InfoBar) pick up the updated stdout.columns without their own
 * listeners.
 */
export function Dock({
  statusSummary,
  time,
  infoItems,
  promptLabel,
  onSubmit,
  isPromptActive,
  useInputActive = true,
  onAbort,
  commandOutput,
  onCommandOutputClear,
  waitingElement,
  inputHistory,
  ctrlCHint,
  onCtrlC,
  onExpandMemories,
  onShowToolCalls,
}: DockProps): React.ReactElement {
  const [inputValue, setInputValue] = useState('');

  const handleInputChange = useCallback(
    (value: string) => {
      setInputValue(value);
      if (commandOutput && value.length > 0) {
        onCommandOutputClear?.();
      }
    },
    [commandOutput, onCommandOutputClear]
  );

  const showAutocomplete = inputValue.startsWith('/') && !commandOutput;
  const showCommandOutput =
    commandOutput && commandOutput.length > 0 && !inputValue.startsWith('/');

  return (
    <Box flexDirection="column">
      {waitingElement}
      <Separator />
      <PromptInput
        label={promptLabel}
        onSubmit={onSubmit}
        isActive={isPromptActive}
        useInputActive={useInputActive}
        onAbort={onAbort}
        onEscape={onCommandOutputClear}
        onCtrlC={onCtrlC}
        onExpandMemories={onExpandMemories}
        onShowToolCalls={onShowToolCalls}
        onInputChange={handleInputChange}
        history={inputHistory}
      />
      {showAutocomplete && <SlashAutocomplete input={inputValue} />}
      {showCommandOutput && (
        <Box flexDirection="column" paddingX={1}>
          {commandOutput.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Separator />
      {ctrlCHint ? (
        <Box paddingX={1}>
          <Text dimColor>Press </Text>
          <Text color="yellow">ctrl+c</Text>
          <Text dimColor> again to quit</Text>
        </Box>
      ) : (
        <InfoBar items={[...infoItems, statusSummary]} right={time} />
      )}
    </Box>
  );
}

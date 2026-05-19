import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { filterCommands } from '../slash-commands.js';

interface SlashAutocompleteProps {
  input: string;
  maxItems?: number;
}

const MAX_VISIBLE = 8;

export function SlashAutocomplete({
  input,
  maxItems = MAX_VISIBLE,
}: SlashAutocompleteProps): React.ReactElement | null {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  const matches = filterCommands(input);
  if (matches.length === 0) return null;

  const visible = matches.slice(0, maxItems);
  const remaining = matches.length - visible.length;

  const nameColWidth = Math.min(24, Math.max(...visible.map((c) => c.name.length + 1)) + 2);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((cmd) => {
        const maxDesc = cols - nameColWidth - 4;
        const desc =
          cmd.description.length > maxDesc
            ? cmd.description.slice(0, Math.max(1, maxDesc - 1)) + '…'
            : cmd.description;
        return (
          <Box key={cmd.name}>
            <Text color="white">
              {'/'}
              {cmd.name}
            </Text>
            <Text>{' '.repeat(Math.max(1, nameColWidth - cmd.name.length - 1))}</Text>
            <Text dimColor>{desc}</Text>
          </Box>
        );
      })}
      {remaining > 0 && <Text dimColor> +{remaining} more</Text>}
    </Box>
  );
}

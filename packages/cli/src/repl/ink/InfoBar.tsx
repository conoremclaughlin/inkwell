import React from 'react';
import { Box, Text, useStdout } from 'ink';

interface InfoBarProps {
  items: string[];
}

/** Bottom hints bar: /help · ctrl+c · branch · path. */
export function InfoBar({ items }: InfoBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  // Guarantee single visual line: pad = 2 (paddingX)
  const maxWidth = cols - 2;
  const joined = items.filter(Boolean).join('  ·  ');
  const truncated =
    joined.length > maxWidth ? joined.slice(0, Math.max(1, maxWidth - 1)) + '…' : joined;

  return (
    <Box paddingX={1}>
      <Text dimColor wrap="truncate">
        {truncated}
      </Text>
    </Box>
  );
}

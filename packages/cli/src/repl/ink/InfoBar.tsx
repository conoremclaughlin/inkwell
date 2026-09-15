import React from 'react';
import { Box, Text, useStdout } from 'ink';

interface InfoBarProps {
  items: string[];
  /** Right-aligned slot (the clock). */
  right?: string;
}

/** Bottom chrome bar: path · branch · context status on the left, clock on the right. */
export function InfoBar({ items, right }: InfoBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  // Guarantee single visual line: pad = 2 (paddingX), gap = 2 (min space
  // between the left run and the right slot).
  const maxWidth = cols - 2 - (right ? right.length + 2 : 0);
  const joined = items.filter(Boolean).join('  ·  ');
  const truncated =
    joined.length > maxWidth ? joined.slice(0, Math.max(1, maxWidth - 1)) + '…' : joined;

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor wrap="truncate">
        {truncated}
      </Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}

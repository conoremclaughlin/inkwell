import React from 'react';
import { Box, Text, useStdout } from 'ink';

interface StatusBarProps {
  summary: string;
  time: string;
}

/** Top bar: context budget + queue status on left, clock on right. */
export function StatusBar({ summary, time }: StatusBarProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  // Guarantee single visual line: pad = 2 (paddingX), gap = 2 (min space between)
  const maxSummary = cols - 2 - time.length - 2;
  const truncated =
    maxSummary > 0 && summary.length > maxSummary
      ? summary.slice(0, Math.max(1, maxSummary - 1)) + '…'
      : summary;

  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor wrap="truncate">
        {truncated}
      </Text>
      <Text dimColor>{time}</Text>
    </Box>
  );
}

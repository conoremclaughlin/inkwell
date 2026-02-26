import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  summary: string;
  time: string;
}

/** Top bar: context budget + queue status on left, clock on right. */
export function StatusBar({ summary, time }: StatusBarProps): React.ReactElement {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>{summary}</Text>
      <Text dimColor>{time}</Text>
    </Box>
  );
}

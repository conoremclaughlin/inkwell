import React from 'react';
import { Box, Text } from 'ink';

interface InfoBarProps {
  items: string[];
}

/** Bottom hints bar: /help · ctrl+c · branch · path. */
export function InfoBar({ items }: InfoBarProps): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text dimColor>{items.filter(Boolean).join('  ·  ')}</Text>
    </Box>
  );
}

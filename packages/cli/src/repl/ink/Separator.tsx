import React from 'react';
import { Text, useStdout } from 'ink';

interface SeparatorProps {
  char?: string;
}

/** Full-width dimmed horizontal rule. Adapts to terminal width. */
export function Separator({ char = '─' }: SeparatorProps): React.ReactElement {
  const { stdout } = useStdout();
  // Subtract 1 to prevent wrapping when terminal width is exact
  const width = Math.max(1, (stdout?.columns || 80) - 1);
  return <Text dimColor>{char.repeat(width)}</Text>;
}

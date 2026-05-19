import React from 'react';
import { Text, useStdout } from 'ink';

interface SeparatorProps {
  char?: string;
}

/** Full-width dimmed horizontal rule. Ink re-renders on resize automatically. */
export function Separator({ char = '─' }: SeparatorProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;

  // Subtract 2 to prevent wrapping (accounts for Ink's layout padding)
  const width = Math.max(1, cols - 2);
  return <Text dimColor>{char.repeat(width)}</Text>;
}

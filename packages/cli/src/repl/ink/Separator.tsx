import React from 'react';
import { Text, useStdout } from 'ink';

interface SeparatorProps {
  char?: string;
}

/** Full-width dimmed horizontal rule. Adapts to terminal width. */
export function Separator({ char = '─' }: SeparatorProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  return <Text dimColor>{char.repeat(width)}</Text>;
}

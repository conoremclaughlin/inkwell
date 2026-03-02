import React, { useState, useEffect } from 'react';
import { Text, useStdout } from 'ink';

interface SeparatorProps {
  char?: string;
}

/** Full-width dimmed horizontal rule. Re-measures on terminal resize. */
export function Separator({ char = '─' }: SeparatorProps): React.ReactElement {
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns || 80);

  useEffect(() => {
    const onResize = () => {
      setCols(stdout?.columns || 80);
    };
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  // Subtract 2 to prevent wrapping (accounts for Ink's layout padding)
  const width = Math.max(1, cols - 2);
  return <Text dimColor>{char.repeat(width)}</Text>;
}

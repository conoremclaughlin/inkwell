import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface SessionPickerEntry {
  id: string;
  label: string;
  phase?: string;
  threadKey?: string;
  studioName?: string;
  backend?: string;
  historyLabel?: string;
  lastMessage?: string;
  preview?: string;
}

interface SessionPickerProps {
  entries: SessionPickerEntry[];
  onSelect: (entry: SessionPickerEntry | null) => void;
}

export function SessionPicker({ entries, onSelect }: SessionPickerProps): React.ReactElement {
  // Index 0 = "New session", 1..N = existing sessions
  const totalItems = entries.length + 1;
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected((prev) => (prev > 0 ? prev - 1 : totalItems - 1));
    } else if (key.downArrow) {
      setSelected((prev) => (prev < totalItems - 1 ? prev + 1 : 0));
    } else if (key.return) {
      if (selected === 0) {
        onSelect(null); // new session
      } else {
        onSelect(entries[selected - 1]!);
      }
    } else if (key.escape || (input === 'q' && !key.shift) || (key.ctrl && input === 'c')) {
      onSelect(null); // cancel → fall through to new session
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Select session</Text>
        <Text dimColor> — ↑↓ navigate, Enter select, Esc new session</Text>
      </Box>

      {/* New session option */}
      <Box>
        <Text color={selected === 0 ? 'cyan' : undefined} bold={selected === 0}>
          {selected === 0 ? '▸ ' : '  '}
        </Text>
        <Text color={selected === 0 ? 'cyan' : 'green'} bold={selected === 0}>
          + New session
        </Text>
      </Box>

      {entries.map((entry, i) => {
        const idx = i + 1;
        const isSelected = selected === idx;
        const phase = entry.phase || 'active';
        const parts = [
          entry.historyLabel,
          entry.threadKey ? `thread:${entry.threadKey}` : null,
          entry.studioName,
          entry.backend,
        ].filter(Boolean);

        return (
          <Box key={entry.id} flexDirection="column">
            <Box>
              <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {isSelected ? '▸ ' : '  '}
              </Text>
              <Text color={isSelected ? 'cyan' : 'white'}>{entry.id.slice(0, 8)}</Text>
              <Text dimColor>
                {'  '}
                {phase}
              </Text>
              {parts.length > 0 && (
                <Text dimColor>
                  {'  ·  '}
                  {parts.join('  ·  ')}
                </Text>
              )}
            </Box>
            {entry.preview && (
              <Box marginLeft={4}>
                <Text dimColor wrap="truncate-end">
                  ↳ {entry.preview}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

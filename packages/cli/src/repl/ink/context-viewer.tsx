import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

export interface ContextSections {
  bootstrapSummary?: string;
  passiveRecallEntries: Array<{ content: string; source?: string }>;
  passiveRecallStats: {
    totalInjected: number;
    uniqueMemories: number;
    currentTurn: number;
  };
  ledgerStats: {
    totalEntries: number;
    tokenEstimate: number;
    bootstrapTokens: number;
  };
  /** Tool calls executed this session (most recent last) */
  toolCalls?: Array<{ tool: string; status: string; at: string }>;
}

export function formatContextLines(sections: ContextSections): string[] {
  const lines: string[] = [];

  lines.push('');
  lines.push('Context Inspector');
  lines.push('');

  lines.push('── Ledger ──');
  lines.push(`Entries: ${sections.ledgerStats.totalEntries}`);
  lines.push(`Transcript tokens: ~${sections.ledgerStats.tokenEstimate.toLocaleString()}`);
  lines.push(`Bootstrap tokens: ~${sections.ledgerStats.bootstrapTokens.toLocaleString()}`);
  lines.push('');

  lines.push('── Passive Recall ──');
  lines.push(`Injected: ${sections.passiveRecallStats.totalInjected} total`);
  lines.push(`Unique memories: ${sections.passiveRecallStats.uniqueMemories}`);
  lines.push(`Current turn: ${sections.passiveRecallStats.currentTurn}`);
  lines.push('');

  if (sections.toolCalls && sections.toolCalls.length > 0) {
    lines.push('── Recent Tool Calls ──');
    lines.push('');
    // Most recent first, capped for readability
    const recent = sections.toolCalls.slice(-25).reverse();
    for (const call of recent) {
      const time = call.at ? new Date(call.at).toLocaleTimeString() : '';
      lines.push(`• ${call.tool} (${call.status})${time ? ` · ${time}` : ''}`);
    }
    lines.push('');
  }

  if (sections.passiveRecallEntries.length > 0) {
    lines.push('── Memories in Context ──');
    lines.push('');
    for (const entry of sections.passiveRecallEntries) {
      const content = entry.content.replace(/^\[passive-recall\]\s*/, '');
      lines.push(`• ${content}`);
      lines.push('');
    }
  } else {
    lines.push('No passive recall memories currently in context.');
    lines.push('');
  }

  if (sections.bootstrapSummary) {
    lines.push('── Bootstrap Context ──');
    lines.push('');
    for (const line of sections.bootstrapSummary.split('\n')) {
      lines.push(line);
    }
    lines.push('');
  }

  return lines;
}

interface ContextViewerProps {
  lines: string[];
  isActive: boolean;
  onDismiss: () => void;
}

export function ContextViewer({
  lines,
  isActive,
  onDismiss,
}: ContextViewerProps): React.ReactElement {
  const { stdout } = useStdout();
  const viewportHeight = Math.max(5, (stdout?.rows || 24) - 4);
  const [scrollOffset, setScrollOffset] = useState(0);
  const maxScroll = Math.max(0, lines.length - viewportHeight);

  const scrollUp = useCallback(
    (amount = 1) => setScrollOffset((prev) => Math.max(0, prev - amount)),
    []
  );
  const scrollDown = useCallback(
    (amount = 1) => setScrollOffset((prev) => Math.min(maxScroll, prev + amount)),
    [maxScroll]
  );

  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || input === 'Q') {
        onDismiss();
        return;
      }
      if (key.upArrow) {
        scrollUp();
        return;
      }
      if (key.downArrow) {
        scrollDown();
        return;
      }
      if (input === 'k') {
        scrollUp();
        return;
      }
      if (input === 'j') {
        scrollDown();
        return;
      }
      // Page up/down via shift+arrows
      if (key.shift && key.upArrow) {
        scrollUp(viewportHeight);
        return;
      }
      if (key.shift && key.downArrow) {
        scrollDown(viewportHeight);
        return;
      }
      // Ctrl+U / Ctrl+D for half-page
      if (key.ctrl && input === 'u') {
        scrollUp(Math.floor(viewportHeight / 2));
        return;
      }
      if (key.ctrl && input === 'd') {
        scrollDown(Math.floor(viewportHeight / 2));
        return;
      }
    },
    { isActive }
  );

  const visible = lines.slice(scrollOffset, scrollOffset + viewportHeight);
  const scrollPct = maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * 100) : 100;
  const position = `${scrollOffset + 1}-${Math.min(scrollOffset + viewportHeight, lines.length)} of ${lines.length}`;

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold inverse>
          {' '}
          Context Inspector{' '}
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {visible.map((line, i) => {
          if (line.startsWith('──')) {
            return (
              <Text key={scrollOffset + i} color="cyan">
                {line}
              </Text>
            );
          }
          if (line === 'Context Inspector') {
            return (
              <Text key={scrollOffset + i} bold>
                {line}
              </Text>
            );
          }
          return <Text key={scrollOffset + i}>{line || ' '}</Text>;
        })}
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>q/esc: close · ↑↓/j/k: scroll · ctrl+u/d: page</Text>
        <Text dimColor>
          {position} {scrollPct}%
        </Text>
      </Box>
    </Box>
  );
}

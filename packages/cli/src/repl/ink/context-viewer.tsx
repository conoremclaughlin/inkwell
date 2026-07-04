import React, { useState, useCallback, useMemo } from 'react';
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
  /** Tool calls executed this session or replayed from the transcript (most recent last) */
  toolCalls?: Array<{ tool: string; status: string; at: string; args?: string }>;
  /** Entries evicted from the context window — out of the prompt, not erased */
  evicted?: Array<{
    role: string;
    source?: string;
    preview: string;
    actor?: string;
    reason?: string;
  }>;
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
      if (call.args) {
        lines.push(`    ${call.args}`);
      }
    }
    lines.push('');
  }

  if (sections.evicted && sections.evicted.length > 0) {
    lines.push('── Evicted from Context ──');
    lines.push('(out of the prompt window — still in the transcript)');
    lines.push('');
    const recentEvicted = sections.evicted.slice(-25).reverse();
    for (const entry of recentEvicted) {
      const attribution = [entry.actor, entry.reason].filter(Boolean).join(' · ');
      lines.push(
        `✕ [${entry.role}${entry.source ? `/${entry.source}` : ''}] ${entry.preview}${attribution ? ` (${attribution})` : ''}`
      );
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

/**
 * Single-key section jumps for the viewer. Maps a key to the line index of
 * its section header, when the section is present in the rendered lines.
 */
export const SECTION_JUMP_KEYS: ReadonlyArray<{ key: string; header: string; label: string }> = [
  { key: 'e', header: '── Evicted from Context ──', label: 'evicted' },
  { key: 't', header: '── Recent Tool Calls ──', label: 'tools' },
  { key: 'm', header: '── Memories in Context ──', label: 'memories' },
  { key: 'b', header: '── Bootstrap Context ──', label: 'bootstrap' },
];

export function computeSectionJumps(lines: string[]): Map<string, number> {
  const jumps = new Map<string, number>();
  for (const { key, header } of SECTION_JUMP_KEYS) {
    const index = lines.indexOf(header);
    if (index >= 0) jumps.set(key, index);
  }
  return jumps;
}

interface ContextViewerProps {
  lines: string[];
  isActive: boolean;
  onDismiss: () => void;
  /** Open scrolled to a section (a SECTION_JUMP_KEYS key, e.g. 't' for tools) */
  initialSection?: string;
}

export function ContextViewer({
  lines,
  isActive,
  onDismiss,
  initialSection,
}: ContextViewerProps): React.ReactElement {
  const { stdout } = useStdout();
  const viewportHeight = Math.max(5, (stdout?.rows || 24) - 4);
  const sectionJumps = useMemo(() => computeSectionJumps(lines), [lines]);
  const maxScroll = Math.max(0, lines.length - viewportHeight);
  const [scrollOffset, setScrollOffset] = useState(() => {
    const target = initialSection ? sectionJumps.get(initialSection) : undefined;
    return target !== undefined ? Math.min(maxScroll, target) : 0;
  });

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
      // Ctrl+T re-jumps to Tool Calls — the viewer owns stdin while open,
      // so the prompt's Ctrl+T binding can't fire; mirror it here.
      if (key.ctrl && input === 't') {
        const target = sectionJumps.get('t');
        if (target !== undefined) {
          setScrollOffset(Math.min(maxScroll, target));
        }
        return;
      }
      // Section jumps (e: evicted, t: tools, m: memories, b: bootstrap)
      if (!key.ctrl && !key.meta) {
        const target = sectionJumps.get(input.toLowerCase());
        if (target !== undefined) {
          setScrollOffset(Math.min(maxScroll, target));
          return;
        }
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
        <Text dimColor>
          q/esc: close · ↑↓/j/k: scroll · ctrl+u/d: page
          {sectionJumps.size > 0
            ? ` · ${SECTION_JUMP_KEYS.filter((s) => sectionJumps.has(s.key))
                .map((s) => `${s.key}: ${s.label}`)
                .join(' · ')}`
            : ''}
        </Text>
        <Text dimColor>
          {position} {scrollPct}%
        </Text>
      </Box>
    </Box>
  );
}

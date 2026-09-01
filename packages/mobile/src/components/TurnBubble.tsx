import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ContentBlock, ConversationTurn } from '../lib/transcript';
import { messageTime, toolCallLabel } from '../ui/format';
import { colors, spacing, type } from '../ui/theme';

/**
 * One transcript turn. The chat grammar matches MessageBubble (user right,
 * agent left) so a session reads like the thread it worked on, but a turn is
 * richer than a message: tool calls become compact rows, tool results stay
 * hidden unless they errored, and thinking is collapsed behind a tap — the
 * point of reading a session on a phone is to follow the work, not audit it.
 */

const RESULT_PREVIEW_CHARS = 400;

function ToolCallRow({ block }: { block: Extract<ContentBlock, { kind: 'tool-call' }> }) {
  return (
    <Text style={styles.toolRow} numberOfLines={2}>
      <Text style={styles.toolGlyph}>⚙ </Text>
      {toolCallLabel(block.name, block.input)}
    </Text>
  );
}

function ToolErrorRow({ block }: { block: Extract<ContentBlock, { kind: 'tool-result' }> }) {
  const preview =
    block.content.length > RESULT_PREVIEW_CHARS
      ? `${block.content.slice(0, RESULT_PREVIEW_CHARS)}…`
      : block.content;
  return (
    <View style={styles.toolError}>
      <Text style={styles.toolErrorLabel}>tool error</Text>
      <Text style={styles.toolErrorText} selectable>
        {preview}
      </Text>
    </View>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((v) => !v)} hitSlop={4}>
      <Text style={styles.thinkingToggle}>{open ? '▾ thinking' : '▸ thinking'}</Text>
      {open ? (
        <Text style={styles.thinkingText} selectable>
          {text}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function TurnBubble({ turn, agentName }: { turn: ConversationTurn; agentName: string }) {
  if (turn.role === 'system') {
    const block = turn.blocks[0];
    const text = block?.kind === 'system' ? block.text : ((block as { text?: string })?.text ?? '');
    const subtype = block?.kind === 'system' ? block.subtype : undefined;
    return (
      <View style={styles.systemWrap}>
        <Text style={styles.systemText} numberOfLines={4}>
          {subtype ? `${subtype}: ` : ''}
          {text}
        </Text>
      </View>
    );
  }

  const isUser = turn.role === 'user';
  // A user turn that is nothing but tool results carries no words to show;
  // surface only the errors, as the web viewer does.
  const visible = turn.blocks.filter((b) => b.kind !== 'tool-result' || b.isError);
  if (visible.length === 0) return null;

  return (
    <View style={[styles.wrap, isUser ? styles.wrapUser : styles.wrapAgent]}>
      <View style={styles.header}>
        <Text
          style={[styles.sender, { color: isUser ? colors.accentBright : colors.textSecondary }]}
        >
          {isUser ? 'You' : agentName}
        </Text>
        {turn.timestamp ? <Text style={styles.time}>{messageTime(turn.timestamp)}</Text> : null}
      </View>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        {visible.map((block, index) => {
          const key = `${turn.id}-${index}`;
          switch (block.kind) {
            case 'text':
              return (
                <Text key={key} style={styles.content} selectable>
                  {block.text.trim()}
                </Text>
              );
            case 'tool-call':
              return <ToolCallRow key={key} block={block} />;
            case 'tool-result':
              return <ToolErrorRow key={key} block={block} />;
            case 'thinking':
              return <ThinkingRow key={key} text={block.text} />;
            case 'system':
              return (
                <Text key={key} style={styles.systemInline}>
                  {block.text}
                </Text>
              );
            default:
              return null;
          }
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, marginVertical: spacing.xs, maxWidth: '100%' },
  wrapUser: { alignItems: 'flex-end' },
  wrapAgent: { alignItems: 'flex-start' },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginBottom: 3 },
  sender: { ...type.label },
  time: { ...type.caption, color: colors.textMuted },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    maxWidth: '94%',
    gap: spacing.xs,
  },
  bubbleAgent: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderTopLeftRadius: 4,
  },
  bubbleUser: { backgroundColor: colors.accentDim, borderTopRightRadius: 4 },
  content: { ...type.body, color: colors.textPrimary, lineHeight: 21 },
  toolRow: { ...type.mono, fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  toolGlyph: { color: colors.textMuted },
  toolError: {
    backgroundColor: colors.well,
    borderRadius: 8,
    padding: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.negative,
    gap: 2,
  },
  toolErrorLabel: { ...type.label, color: colors.negative },
  toolErrorText: { ...type.mono, fontSize: 12, color: colors.textSecondary },
  thinkingToggle: { ...type.caption, color: colors.textMuted, fontStyle: 'italic' },
  thinkingText: {
    ...type.caption,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: 2,
  },
  systemWrap: { paddingHorizontal: spacing.xl, marginVertical: spacing.sm, alignItems: 'center' },
  systemText: { ...type.caption, color: colors.textMuted, textAlign: 'center' },
  systemInline: { ...type.caption, color: colors.textMuted },
});

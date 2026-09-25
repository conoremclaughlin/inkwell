import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  formatClockTime,
  messageLabel,
  parseMarkdown,
  shouldFold,
  type ConversationMessage,
  type MarkdownBlock,
} from '@inklabs/shared/stories/thread-viewing';
import { agentColor, colors, spacing, type } from '../ui/theme';
import { hasWideBlocks, MarkdownView } from './MarkdownView';

/**
 * One message. The viewer's own replies sit right and accent-tinted; SBs and
 * other people sit left with their identity hue on the name: the familiar
 * chat grammar, because that's the point of the app.
 *
 * `continuation` is the timeline's call (the shared thread-viewing story): a
 * message from the same author within a few minutes of their last one drops
 * its header and tucks under the one above, as in any chat.
 *
 * System events ("thread closed", "turn cut short") read in full as a quiet
 * centred note. Anything long, event or message, starts folded.
 */

/** A folded body shows about this much before "Show more". */
const FOLDED_HEIGHT = 320;

function FoldableBody({
  message,
  blocks,
  tone,
}: {
  message: ConversationMessage;
  blocks: MarkdownBlock[];
  tone: 'default' | 'muted';
}) {
  const foldable = !message.streaming && shouldFold(message.body);
  const [open, setOpen] = useState(false);
  const folded = foldable && !open;
  return (
    <View>
      <View style={folded ? styles.folded : null}>
        <MarkdownView body={message.body} blocks={blocks} tone={tone} />
      </View>
      {foldable ? (
        <Pressable
          onPress={() => setOpen(!open)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={open ? 'Show less' : 'Show the whole message'}
        >
          <Text style={styles.foldToggle}>{open ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  continuation,
}: {
  message: ConversationMessage;
  continuation: boolean;
}) {
  const { author } = message;
  const blocks = useMemo(() => parseMarkdown(message.body), [message.body]);
  // A bubble sizes to its text, which suits a sentence and starves a table
  // or a code block: those scroll sideways and have no width of their own.
  const wide = hasWideBlocks(blocks);

  if (author.kind === 'system') {
    return (
      <View style={styles.systemWrap}>
        <View style={styles.systemNote}>
          <FoldableBody message={message} blocks={blocks} tone="muted" />
          <Text style={styles.systemTime}>{formatClockTime(message.createdAt)}</Text>
        </View>
      </View>
    );
  }

  const label = message.label ? messageLabel(message.label) : null;
  const urgent = message.priority === 'high' || message.priority === 'urgent';

  return (
    <View
      style={[
        styles.wrap,
        author.isOwn ? styles.wrapOwn : styles.wrapOther,
        continuation ? styles.wrapContinuation : null,
      ]}
    >
      {continuation ? null : (
        <View style={styles.header}>
          <Text
            style={[
              styles.sender,
              { color: author.isOwn ? colors.accentBright : agentColor(author.id) },
            ]}
          >
            {author.name}
          </Text>
          <Text style={styles.time}>{formatClockTime(message.createdAt)}</Text>
          {label ? <Text style={styles.label}>{label}</Text> : null}
          {urgent ? (
            <Text style={[styles.priority, message.priority === 'urgent' && styles.urgent]}>
              {message.priority}
            </Text>
          ) : null}
        </View>
      )}
      <View
        style={[
          styles.bubble,
          author.isOwn ? styles.bubbleOwn : styles.bubbleOther,
          continuation && (author.isOwn ? styles.bubbleOwnContinued : styles.bubbleOtherContinued),
          urgent && !author.isOwn ? styles.bubbleUrgent : null,
          wide ? styles.bubbleWide : null,
        ]}
      >
        <FoldableBody message={message} blocks={blocks} tone="default" />
      </View>
    </View>
  );
});

/** "Today", "Yesterday", "Mon, Sep 21": where one day's messages start. */
export function DayDivider({ label }: { label: string }) {
  return (
    <View style={styles.dayWrap} accessibilityRole="header">
      <Text style={styles.dayLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, marginTop: spacing.md, maxWidth: '100%' },
  wrapContinuation: { marginTop: 3 },
  wrapOwn: { alignItems: 'flex-end' },
  wrapOther: { alignItems: 'flex-start' },
  header: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginBottom: 3 },
  sender: { ...type.label, fontSize: 12 },
  time: { ...type.caption, color: colors.textMuted },
  label: {
    ...type.label,
    color: colors.textSecondary,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: 4,
    paddingHorizontal: 5,
    overflow: 'hidden',
  },
  priority: { ...type.label, color: colors.warning },
  urgent: { color: colors.negative },
  bubble: {
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    maxWidth: '94%',
  },
  bubbleOther: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderTopLeftRadius: 4,
  },
  bubbleOtherContinued: { borderTopLeftRadius: 14 },
  bubbleOwn: { backgroundColor: colors.accentDim, borderTopRightRadius: 4 },
  bubbleOwnContinued: { borderTopRightRadius: 14 },
  bubbleUrgent: { borderColor: colors.warning },
  bubbleWide: { width: '94%' },
  folded: { maxHeight: FOLDED_HEIGHT, overflow: 'hidden' },
  foldToggle: { ...type.label, color: colors.accentBright, marginTop: spacing.sm },
  systemWrap: {
    paddingHorizontal: spacing.xl,
    marginVertical: spacing.md,
    alignItems: 'center',
  },
  systemNote: {
    maxWidth: '100%',
    backgroundColor: colors.well,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  systemTime: { ...type.caption, color: colors.textMuted, marginTop: 4, textAlign: 'right' },
  dayWrap: { alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.xs },
  dayLabel: {
    ...type.label,
    color: colors.textSecondary,
    backgroundColor: colors.surface,
    borderRadius: 10,
    overflow: 'hidden',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
});

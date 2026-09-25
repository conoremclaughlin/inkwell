import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  displayTitle,
  liveAgentsOf,
  previewLine,
  spineStatus,
} from '@inklabs/shared/stories/thread-browsing';
import type { ThreadSpine } from '../lib/types';
import { agentColor, colors, spacing, type } from '../ui/theme';

/** The app shows SBs by slug; it loads no identities to name them otherwise. */
const nameFor = (sbSlug: string) => sbSlug;

/**
 * One thread in the list, read like a chat app's: what it is (title, or the
 * key when it has none), what was said last and by whom, and whether anyone
 * is working on it RIGHT NOW. That last one is the whole point of following
 * along from a phone.
 *
 * Memoised, because the list polls every 20s and re-rendering every row on
 * each poll is what produced RN's "large list is slow to update" warning
 * (measured dt 1223ms on a 19.7s interval — i.e. the poll, not scrolling).
 * The memo is effective because react-query's structural sharing (on by
 * default) keeps the identity of spines the poll did not change.
 *
 * `timeLabel` is passed in rather than computed here on purpose. "4m" has to
 * keep up with the clock, but a row that recomputed it would need to
 * re-render on a timer, which is the cost we just removed. The parent owns a
 * coarse clock, hands down the finished string, and memo then re-renders a
 * row only when its label actually changes — so a row sitting at "3h"
 * re-renders once an hour instead of every tick.
 */
export const ThreadRow = memo(function ThreadRow({
  spine,
  timeLabel,
  onPress,
}: {
  spine: ThreadSpine;
  timeLabel: string;
  onPress: (spine: ThreadSpine) => void;
}) {
  // Presence is the server's verdict (isSessionLive), shared with the web
  // list. A client-side `lifecycle === 'running'` test marked ~50 threads as
  // "wren live" for sessions abandoned as long ago as March.
  const live = liveAgentsOf(spine);
  const closed = spineStatus(spine) === 'closed';
  const title = displayTitle(spine);
  const lastMessage = spine.thread?.lastMessage;
  const preview = lastMessage ? previewLine(lastMessage, nameFor) : null;
  const participants = spine.participants.slice(0, 5);

  return (
    <Pressable
      onPress={() => onPress(spine)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={`Thread ${title ?? spine.key}`}
    >
      <View style={styles.topLine}>
        <Text style={[styles.title, closed && styles.closedText]} numberOfLines={1}>
          {title ?? spine.key}
        </Text>
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      {preview ? (
        <Text style={[styles.preview, closed && styles.closedText]} numberOfLines={2}>
          <Text style={[styles.previewSender, closed && styles.closedText]}>
            {preview.sender}:{' '}
          </Text>
          {preview.text}
        </Text>
      ) : spine.thread?.summary ? (
        <Text style={[styles.preview, closed && styles.closedText]} numberOfLines={2}>
          {spine.thread.summary}
        </Text>
      ) : null}

      <View style={styles.bottomLine}>
        <View style={styles.meta}>
          {participants.map((p) => (
            <View key={p} style={[styles.dot, { backgroundColor: agentColor(p) }]} />
          ))}
          {title ? (
            <Text style={styles.key} numberOfLines={1}>
              {spine.key}
            </Text>
          ) : null}
        </View>
        {live.length > 0 ? (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>
              {live.length === 1 ? `${live[0]} live` : `${live.length} live`}
            </Text>
          </View>
        ) : closed ? (
          <Text style={styles.closedBadge}>closed</Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.xs,
  },
  topLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { ...type.title, fontSize: 16, color: colors.textPrimary, flex: 1 },
  time: { ...type.caption, color: colors.textMuted },
  preview: { ...type.body, fontSize: 14, color: colors.textSecondary, lineHeight: 19 },
  previewSender: { color: colors.textPrimary, fontWeight: '600' },
  bottomLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  key: { ...type.mono, fontSize: 11, color: colors.textMuted, marginLeft: 3, flexShrink: 1 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.positive },
  liveText: { ...type.label, color: colors.positive },
  closedBadge: { ...type.label, color: colors.textMuted },
  closedText: { color: colors.textMuted },
});

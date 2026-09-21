import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThreadSpine } from '../lib/types';
import { agentColor, colors, spacing, type } from '../ui/theme';

/**
 * One thread in the list. The row answers three glance-questions: what is
 * this (key + title + summary), who's in it (participant dots), and is
 * anything HAPPENING right now (live pulse) — that last one is the whole
 * point of following along from a phone.
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
  // Presence is the server's verdict (isSessionLive), not a lifecycle check
  // repeated here. A client-side `lifecycle === 'running'` test marked ~50
  // threads as "wren live" for sessions abandoned as long ago as March.
  const live = spine.sessions.filter((s) => s.live);
  const closed = spine.thread?.status === 'closed' || !!spine.thread?.closedAt;
  const participants = spine.participants.slice(0, 5);

  return (
    <Pressable
      onPress={() => onPress(spine)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={`Thread ${spine.key}`}
    >
      <View style={styles.topLine}>
        <Text style={[styles.key, closed && styles.closedText]} numberOfLines={1}>
          {spine.key}
        </Text>
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      {spine.thread?.title ? (
        <Text style={[styles.title, closed && styles.closedText]} numberOfLines={2}>
          {spine.thread.title}
        </Text>
      ) : null}

      {spine.thread?.summary ? (
        <Text style={[styles.summary, closed && styles.closedText]} numberOfLines={2}>
          {spine.thread.summary}
        </Text>
      ) : null}

      <View style={styles.bottomLine}>
        <View style={styles.dots}>
          {participants.map((p) => (
            <View key={p} style={[styles.dot, { backgroundColor: agentColor(p) }]} />
          ))}
          {participants.length > 0 ? (
            <Text style={styles.participants} numberOfLines={1}>
              {participants.join(' · ')}
            </Text>
          ) : null}
        </View>
        {live.length > 0 ? (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>
              {live.length === 1 ? `${live[0].sbSlug ?? 'agent'} live` : `${live.length} live`}
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
  key: { ...type.title, color: colors.textPrimary, flex: 1 },
  time: { ...type.caption, color: colors.textMuted },
  title: { ...type.body, color: colors.textSecondary },
  summary: { ...type.caption, color: colors.textMuted },
  bottomLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  participants: { ...type.caption, color: colors.textMuted, marginLeft: 3 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.positive },
  liveText: { ...type.label, color: colors.positive },
  closedBadge: { ...type.label, color: colors.textMuted },
  closedText: { color: colors.textMuted },
});

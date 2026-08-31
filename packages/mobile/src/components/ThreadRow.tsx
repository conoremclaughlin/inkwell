import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThreadSpine } from '../lib/types';
import { relativeTime } from '../ui/format';
import { agentColor, colors, spacing, type } from '../ui/theme';

/**
 * One thread in the list. The row answers three glance-questions: what is
 * this (key + title), who's in it (participant dots), and is anything
 * HAPPENING right now (live-session pulse) — that last one is the whole
 * point of following along from a phone.
 */

function isLiveSession(lifecycle: string | null): boolean {
  return lifecycle === 'running' || lifecycle === 'compacting';
}

export function ThreadRow({ spine, onPress }: { spine: ThreadSpine; onPress: () => void }) {
  const live = spine.sessions.filter((s) => isLiveSession(s.lifecycle));
  const closed = spine.thread?.status === 'closed' || !!spine.thread?.closedAt;
  const participants = spine.participants.slice(0, 5);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={`Thread ${spine.key}`}
    >
      <View style={styles.topLine}>
        <Text style={[styles.key, closed && styles.closedText]} numberOfLines={1}>
          {spine.key}
        </Text>
        <Text style={styles.time}>{relativeTime(spine.lastActivityAt)}</Text>
      </View>

      {spine.thread?.title ? (
        <Text style={[styles.title, closed && styles.closedText]} numberOfLines={2}>
          {spine.thread.title}
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
              {live.length === 1 ? `${live[0].agentId ?? 'agent'} live` : `${live.length} live`}
            </Text>
          </View>
        ) : closed ? (
          <Text style={styles.closedBadge}>closed</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

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

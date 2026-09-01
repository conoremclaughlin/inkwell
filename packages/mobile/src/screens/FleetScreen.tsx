import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSessions } from '../hooks/useInkwell';
import type { FleetSession } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { durationLabel, relativeTime, shortPhase } from '../ui/format';
import { agentColor, colors, spacing, type } from '../ui/theme';

/**
 * Who's working, on what, right now — and what they worked on before. Each
 * card is a session; tapping it opens the session's own conversation, and
 * the thread-key pill jumps to the thread the session was talking in. The
 * session is the WORKER, the thread is the conversation about the work.
 */

type Mode = 'active' | 'history';

function lifecycleColor(lifecycle: string): string {
  if (lifecycle === 'running' || lifecycle === 'compacting') return colors.positive;
  if (lifecycle === 'failed') return colors.negative;
  return colors.textMuted;
}

function SessionCard({ session }: { session: FleetSession }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const threadKey = session.activeThreadKey || session.threadKey;
  const phase = shortPhase(session.currentPhase);
  const ended = !!session.endedAt;

  return (
    <Pressable
      onPress={() =>
        navigation.navigate('Session', { sessionId: session.id, title: session.agentName })
      }
      style={({ pressed }) => [styles.card, pressed ? { opacity: 0.8 } : null]}
      accessibilityRole="button"
    >
      <View style={styles.cardHeader}>
        <View style={[styles.lifeDot, { backgroundColor: lifecycleColor(session.lifecycle) }]} />
        <Text style={[styles.agent, { color: agentColor(session.agentId) }]}>
          {session.agentName}
        </Text>
        <Text style={styles.meta}>{session.lifecycle}</Text>
        {phase && !ended ? <Text style={styles.meta}>· {phase}</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={styles.meta}>
          {ended
            ? `${relativeTime(session.endedAt as string)} · ${durationLabel(session.startedAt, session.endedAt)}`
            : relativeTime(session.updatedAt)}
        </Text>
      </View>
      <View style={styles.pillRow}>
        {threadKey ? (
          <Pressable
            onPress={() => navigation.navigate('Thread', { threadKey })}
            hitSlop={6}
            style={styles.pill}
            accessibilityRole="link"
          >
            <Text style={styles.pillText}>{threadKey}</Text>
          </Pressable>
        ) : null}
        {session.studio?.branch ? (
          <Text style={styles.branch} numberOfLines={1}>
            {session.studio.repoName ? `${session.studio.repoName} · ` : ''}
            {session.studio.branch}
          </Text>
        ) : null}
      </View>
      {session.context || session.summary ? (
        <Text style={styles.context} numberOfLines={3}>
          {session.context || session.summary}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function FleetScreen() {
  const [mode, setMode] = useState<Mode>('active');
  const { data, isLoading, error, refetch, isRefetching } = useSessions(mode === 'history');
  const stats = data?.stats;

  const sessions = useMemo(() => {
    const all = data?.sessions ?? [];
    if (mode === 'active') return all;
    // History is the ended sessions, most recently ended first.
    return all
      .filter((s) => s.endedAt || s.lifecycle === 'completed' || s.lifecycle === 'failed')
      .sort((a, b) => Date.parse(b.endedAt ?? b.updatedAt) - Date.parse(a.endedAt ?? a.updatedAt));
  }, [data, mode]);

  return (
    <View style={styles.container}>
      <View style={styles.segment}>
        {(['active', 'history'] as Mode[]).map((m) => (
          <Pressable
            key={m}
            onPress={() => setMode(m)}
            style={[styles.segmentItem, mode === m && styles.segmentItemActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === m }}
          >
            <Text style={[styles.segmentText, mode === m && styles.segmentTextActive]}>
              {m === 'active' ? 'Active' : 'History'}
            </Text>
          </Pressable>
        ))}
      </View>
      {stats && mode === 'active' ? (
        <Text style={styles.stats}>
          {stats.total} sessions · {stats.running + stats.generating} active · {stats.idle} idle
          {stats.blocked ? ` · ${stats.blocked} blocked` : ''}
        </Text>
      ) : null}
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => <SessionCard session={item} />}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          isLoading ? null : (
            <Text style={styles.empty}>
              {error
                ? (error as Error).message
                : mode === 'active'
                  ? 'No active sessions.'
                  : 'No finished sessions yet.'}
            </Text>
          )
        }
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  segment: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 3,
  },
  segmentItem: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  segmentItemActive: { backgroundColor: colors.surfaceOverlay },
  segmentText: { ...type.label, fontSize: 13, color: colors.textMuted },
  segmentTextActive: { color: colors.textPrimary },
  stats: {
    ...type.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lifeDot: { width: 8, height: 8, borderRadius: 4 },
  agent: { ...type.title, fontSize: 15 },
  meta: { ...type.caption, color: colors.textMuted },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  pill: {
    backgroundColor: colors.accentDim,
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { ...type.mono, fontSize: 12, color: colors.accentBright },
  branch: { ...type.caption, color: colors.textMuted, flexShrink: 1 },
  context: { ...type.caption, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl * 2,
  },
});

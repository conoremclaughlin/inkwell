import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSessions } from '../hooks/useInkwell';
import type { FleetSession } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { relativeTime, shortPhase } from '../ui/format';
import { agentColor, colors, spacing, type } from '../ui/theme';

/**
 * Who's working, on what, right now. Each card is a session; tapping one
 * with a thread key jumps into that thread — the session is the WORKER,
 * the thread is the conversation about the work.
 */

function lifecycleColor(lifecycle: string): string {
  if (lifecycle === 'running' || lifecycle === 'compacting') return colors.positive;
  if (lifecycle === 'failed') return colors.negative;
  return colors.textMuted;
}

function SessionCard({ session }: { session: FleetSession }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const threadKey = session.activeThreadKey || session.threadKey;
  const phase = shortPhase(session.currentPhase);

  return (
    <Pressable
      onPress={threadKey ? () => navigation.navigate('Thread', { threadKey }) : undefined}
      style={({ pressed }) => [styles.card, pressed && threadKey ? { opacity: 0.8 } : null]}
      accessibilityRole={threadKey ? 'button' : undefined}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.lifeDot, { backgroundColor: lifecycleColor(session.lifecycle) }]} />
        <Text style={[styles.agent, { color: agentColor(session.agentId) }]}>
          {session.agentName}
        </Text>
        <Text style={styles.meta}>{session.lifecycle}</Text>
        {phase ? <Text style={styles.meta}>· {phase}</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={styles.meta}>{relativeTime(session.updatedAt)}</Text>
      </View>
      {threadKey ? <Text style={styles.threadKey}>{threadKey}</Text> : null}
      {session.context ? (
        <Text style={styles.context} numberOfLines={3}>
          {session.context}
        </Text>
      ) : session.summary ? (
        <Text style={styles.context} numberOfLines={3}>
          {session.summary}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function FleetScreen() {
  const { data, isLoading, error, refetch, isRefetching } = useSessions();
  const stats = data?.stats;

  return (
    <View style={styles.container}>
      {stats ? (
        <Text style={styles.stats}>
          {stats.total} sessions · {stats.running + stats.generating} active · {stats.idle} idle
          {stats.blocked ? ` · ${stats.blocked} blocked` : ''}
        </Text>
      ) : null}
      <FlatList
        data={data?.sessions ?? []}
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
            <Text style={styles.empty}>{error ? (error as Error).message : 'No sessions.'}</Text>
          )
        }
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  stats: {
    ...type.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm },
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
  threadKey: { ...type.mono, color: colors.accentBright },
  context: { ...type.caption, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl * 2,
  },
});

import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { TurnBubble } from '../components/TurnBubble';
import { useSessionConversation, useSessionLogs } from '../hooks/useInkwell';
import { parseTranscript, type ConversationTurn } from '../lib/transcript';
import type { SessionLogItem } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { durationLabel, messageTime, shortPhase } from '../ui/format';
import { agentColor, colors, spacing, type } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Session'>;

/** The /logs fallback is already role-tagged; wrap each entry as a text turn. */
function logsToTurns(logs: SessionLogItem[]): ConversationTurn[] {
  return [...logs]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .filter((log) => log.content?.trim())
    .map((log) => ({
      id: log.id,
      role: log.role === 'in' ? 'user' : log.role === 'out' ? 'assistant' : 'system',
      timestamp: log.timestamp,
      blocks: [{ kind: 'text', text: log.content }],
    }));
}

/**
 * One session, readable as the conversation it was. Transcript first (the
 * synced or local JSONL, parsed per backend), merged logs when there is no
 * transcript to be had — the same two-source strategy as the web viewer.
 * Inverted like ThreadScreen so a live session stays pinned to its latest
 * turn as it polls.
 */
export function SessionScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const conversation = useSessionConversation(sessionId);
  const noTranscript =
    conversation.isError ||
    (conversation.data != null && (conversation.data.transcript?.events.length ?? 0) === 0);
  const logs = useSessionLogs(sessionId, noTranscript);

  const { turns, session, source, agentName } = useMemo(() => {
    const data = conversation.data;
    if (data && data.transcript && data.transcript.events.length > 0) {
      return {
        turns: parseTranscript(data.backend, data.transcript.events),
        session: data.session,
        source: data.source,
        agentName: data.session.agentName,
      };
    }
    if (logs.data) {
      const s = logs.data.session;
      return {
        turns: logsToTurns(logs.data.logs),
        session: {
          ...s,
          agentId: s.agentId ?? 'unknown',
          agentName: s.agentId ?? 'Unknown',
          lifecycle: s.status,
          activeThreadKey: null as string | null,
          backendSessionId: null,
        },
        source: 'logs' as const,
        agentName: s.agentId ?? 'Unknown',
      };
    }
    return {
      turns: [] as ConversationTurn[],
      session: data?.session ?? null,
      source: 'none' as const,
      agentName: data?.session.agentName ?? '',
    };
  }, [conversation.data, logs.data]);

  const inverted = useMemo(() => [...turns].reverse(), [turns]);
  const loading = conversation.isLoading || (noTranscript && logs.isLoading);
  const error = conversation.isError && logs.isError ? (logs.error as Error).message : null;
  const threadKey = session?.activeThreadKey ?? null;
  const live =
    session?.lifecycle === 'running' ||
    session?.lifecycle === 'idle' ||
    session?.lifecycle === 'compacting';

  return (
    <View style={styles.container}>
      <FlatList
        data={inverted}
        inverted
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <TurnBubble turn={item} agentName={agentName} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>
              {error ??
                (source === 'none'
                  ? 'No transcript for this session yet — it may not have synced.'
                  : 'Nothing readable in this session.')}
            </Text>
          )
        }
        // Inverted: the "footer" renders at the TOP — the session's header.
        ListFooterComponent={
          session ? (
            <View style={styles.headerCard}>
              <View style={styles.headerRow}>
                <View
                  style={[
                    styles.lifeDot,
                    { backgroundColor: live ? colors.positive : colors.textMuted },
                  ]}
                />
                <Text style={[styles.agent, { color: agentColor(session.agentId) }]}>
                  {agentName}
                </Text>
                <Text style={styles.meta}>{session.lifecycle ?? 'unknown'}</Text>
                {shortPhase(session.currentPhase) ? (
                  <Text style={styles.meta}>· {shortPhase(session.currentPhase)}</Text>
                ) : null}
              </View>
              <Text style={styles.meta}>
                {session.backend ?? 'claude-code'} · started {messageTime(session.startedAt)}
                {session.endedAt
                  ? ` · ran ${durationLabel(session.startedAt, session.endedAt)}`
                  : ' · live'}
                {source !== 'none' ? ` · ${source}` : ''}
              </Text>
              {threadKey ? (
                <Pressable
                  onPress={() => navigation.navigate('Thread', { threadKey })}
                  hitSlop={6}
                  accessibilityRole="link"
                >
                  <Text style={styles.threadLink}>{threadKey} →</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  listContent: { paddingVertical: spacing.md },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    transform: [{ scaleY: -1 }],
  },
  headerCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.well,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: spacing.xs,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lifeDot: { width: 8, height: 8, borderRadius: 4 },
  agent: { ...type.title, fontSize: 15 },
  meta: { ...type.caption, color: colors.textMuted },
  threadLink: { ...type.mono, color: colors.accentBright, marginTop: 2 },
});

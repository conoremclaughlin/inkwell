import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  displayTitle,
  isSessionLive,
  SESSION_RELATION_LABELS,
  spineStatus,
} from '@inklabs/shared/stories/thread-browsing';
import {
  creatorLabel,
  formatDayLabel,
  formatRelativeTime,
} from '@inklabs/shared/stories/thread-viewing';
import { useThreadMessages, useThreads } from '../hooks/useInkwell';
import type { RootStackParamList } from '../navigation';
import { agentColor, colors, spacing, type } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ThreadDetails'>;

/** The app shows SBs by slug; it loads no identities to name them otherwise. */
const nameFor = (sbSlug: string) => sbSlug;

/**
 * Everything about a thread besides the conversation: its full title and
 * summary (the list and the header cut both short), who is on it, and the
 * work, sessions and studios behind its key. The same facts as the web
 * dashboard's details panel, from the same list payload.
 */
export function ThreadDetailsScreen({ route }: Props) {
  const { threadKey } = route.params;
  // Both queries are the ones the list and the conversation already hold,
  // so this reads from the cache rather than asking again.
  const { data: threads, isLoading } = useThreads();
  const { data: messages } = useThreadMessages(threadKey);
  const spine = threads?.spines.find((s) => s.key === threadKey);

  if (!spine) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>
          {isLoading ? '' : `Nothing is known about ${threadKey} yet.`}
        </Text>
      </View>
    );
  }

  const title = displayTitle(spine);
  const status = spineStatus(spine);
  const thread = spine.thread;
  const createdAt = messages?.thread?.createdAt;
  const people = thread?.people ?? [];
  const sessions = [...spine.sessions].sort(
    (a, b) => Number(isSessionLive(b)) - Number(isSessionLive(a))
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title} selectable>
        {title ?? threadKey}
      </Text>
      <View style={styles.keyLine}>
        <Text style={styles.key} selectable>
          {threadKey}
        </Text>
        <Text style={[styles.status, status === 'closed' && styles.statusClosed]}>
          {status === 'unannounced' ? 'no thread yet' : status}
        </Text>
      </View>
      {thread?.summary ? (
        <Text style={styles.summary} selectable>
          {thread.summary}
        </Text>
      ) : null}
      {thread ? (
        <Text style={styles.caption}>
          Started by {creatorLabel(thread.createdBySlug, nameFor)}
          {createdAt ? ` · ${formatDayLabel(createdAt)}` : ''}
        </Text>
      ) : null}

      {spine.participants.length > 0 ? (
        <Section label={`Participants (${spine.participants.length})`}>
          {spine.participants.map((slug) => (
            <View key={slug} style={styles.item}>
              <View style={[styles.dot, { backgroundColor: agentColor(slug) }]} />
              <Text style={styles.itemText}>{nameFor(slug)}</Text>
            </View>
          ))}
        </Section>
      ) : null}

      {people.length > 0 ? (
        <Section label={`People (${people.length})`}>
          {people.map((person) => (
            <View key={person.userId} style={styles.item}>
              <View style={[styles.dot, { backgroundColor: colors.accentBright }]} />
              <Text style={styles.itemText}>
                {person.isOwn ? `${person.name} (you)` : person.name}
              </Text>
            </View>
          ))}
        </Section>
      ) : null}

      {spine.taskGroups.length > 0 ? (
        <Section label="Work">
          {spine.taskGroups.map((group) => (
            <View key={group.id} style={styles.card}>
              <Text style={styles.itemText}>{group.title}</Text>
              <Text style={styles.caption}>
                {[group.status, group.executionPhase].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}
        </Section>
      ) : null}

      {sessions.length > 0 ? (
        <Section label={`Sessions (${sessions.length})`}>
          {sessions.map((session) => {
            const live = isSessionLive(session);
            return (
              <View key={session.id} style={styles.card}>
                <View style={styles.item}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: live ? colors.positive : colors.textMuted },
                    ]}
                  />
                  <Text style={styles.itemText}>{session.sbSlug ?? 'agent'}</Text>
                  <Text style={styles.caption}>{SESSION_RELATION_LABELS[session.relation]}</Text>
                </View>
                <Text style={styles.caption}>
                  {[live ? 'working' : session.lifecycle, session.phase]
                    .filter(Boolean)
                    .join(' · ')}
                  {` · ${formatRelativeTime(session.updatedAt)}`}
                </Text>
              </View>
            );
          })}
        </Section>
      ) : null}

      {spine.studios.length > 0 ? (
        <Section label="Studios">
          {spine.studios.map((studio) => (
            <View key={studio.id} style={styles.card}>
              <Text style={styles.itemText}>{studio.slug ?? studio.branch}</Text>
              <Text style={styles.caption}>
                {studio.sbSlug} · {studio.branch}
              </Text>
            </View>
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  empty: { ...type.body, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl },
  title: { ...type.title, fontSize: 20, lineHeight: 26, color: colors.textPrimary },
  keyLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  key: { ...type.mono, fontSize: 12, color: colors.textSecondary, flexShrink: 1 },
  status: {
    ...type.label,
    color: colors.positive,
    backgroundColor: colors.surface,
    borderRadius: 4,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  statusClosed: { color: colors.textMuted },
  summary: {
    ...type.body,
    color: colors.textPrimary,
    lineHeight: 21,
    marginTop: spacing.md,
  },
  caption: { ...type.caption, color: colors.textMuted, marginTop: spacing.xs },
  section: { marginTop: spacing.xl },
  sectionLabel: {
    ...type.label,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionBody: { marginTop: spacing.sm, gap: spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  itemText: { ...type.body, color: colors.textPrimary },
  dot: { width: 8, height: 8, borderRadius: 4 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
  },
});

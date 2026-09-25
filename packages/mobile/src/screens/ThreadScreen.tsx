import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useHeaderHeight } from '@react-navigation/elements';
import {
  threadMessagesPath,
  type ThreadMessagesResponse,
} from '@inklabs/shared/stories/threads-api';
import {
  buildTimeline,
  creatorLabel,
  formatDayLabel,
  toConversationMessage,
  useThreadHistory,
  type TimelineItem,
} from '@inklabs/shared/stories/thread-viewing';
import { DayDivider, MessageBubble } from '../components/MessageBubble';
import {
  useReopenThread,
  useSendReply,
  useStartThread,
  useThreadMessages,
} from '../hooks/useInkwell';
import { apiFetch } from '../lib/api';
import { getWorkspaceId, subscribeWorkspace } from '../lib/storage';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, type } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>;

/** The app shows SBs by slug; it loads no identities to name them otherwise. */
const nameFor = (sbSlug: string) => sbSlug;

/**
 * A thread, readable as chat. The list is INVERTED (newest at the bottom,
 * where the composer is) with the timeline reversed to match, which keeps
 * the latest message in place across the 7s polls without scroll
 * bookkeeping.
 *
 * The history is the shared thread-viewing story's, the same the web page
 * runs: every poll is merged in, never replacing what was loaded; a stretch
 * a poll skipped fills itself; and scrolling to the top loads the page
 * before. The timeline (day dividers, grouping) is shared too, so the phone
 * and the dashboard agree on where a day starts and whose header repeats.
 */
export function ThreadScreen(props: Props) {
  // One mount per thread in one workspace. A deep link can reuse this screen
  // for another thread, and Settings can switch the workspace under it (the
  // same key can be another thread there). Keyed, it starts clean: history,
  // and a half-written draft that must never be sent anywhere but where it
  // was written.
  const workspaceId = useSyncExternalStore(subscribeWorkspace, getWorkspaceId);
  const { threadKey } = props.route.params;
  return (
    <ThreadConversation
      key={JSON.stringify([workspaceId, threadKey])}
      workspaceId={workspaceId}
      {...props}
    />
  );
}

function ThreadConversation({
  route,
  navigation,
  workspaceId,
}: Props & { workspaceId: string | null }) {
  const { threadKey, title, recipients, studioSlug } = route.params;
  const { data, dataUpdatedAt, isLoading, error } = useThreadMessages(threadKey);

  // A deep link carries only the key. Once the thread says what it is
  // called, the header does too.
  const loadedTitle = data?.thread?.title;
  useLayoutEffect(() => {
    if (!title && loadedTitle) navigation.setOptions({ title: loadedTitle });
  }, [navigation, title, loadedTitle]);
  const sendReply = useSendReply(threadKey);
  const reopenThread = useReopenThread(threadKey);
  const startThread = useStartThread();
  const [draft, setDraft] = useState('');
  const headerHeight = useHeaderHeight();

  const fetchOlder = useCallback(
    (beforeId: string) => apiFetch<ThreadMessagesResponse>(threadMessagesPath(threadKey, beforeId)),
    [threadKey]
  );
  const {
    history,
    loadingOlder,
    error: historyError,
    loadOlder,
  } = useThreadHistory({
    threadKey,
    scope: workspaceId,
    newestPage: data,
    newestPageAt: dataUpdatedAt,
    newestPageLoading: isLoading,
    fetchOlder,
    // No read cursor on the phone yet (task f1c23fc6 puts it on the
    // server), so there is nothing to catch up to on open.
    openingCursor: null,
  });

  const items = useMemo(() => {
    const messages = history.messages.map((m) => toConversationMessage(m, nameFor));
    return buildTimeline(messages).reverse();
  }, [history.messages]);

  const hasOlder = history.started && !history.oldestReached;
  const closed = data?.thread?.status === 'closed' || !!data?.thread?.closedAt;

  // The server answers an unknown key with thread: null rather than 404.
  // With recipients in hand the composer can START it; without, it can't
  // reply into nowhere.
  const missing = !isLoading && !error && data != null && data.thread == null;
  const canStart = missing && !!recipients && recipients.length > 0;
  // A closed thread still takes replies — closed is a work-state signal, not
  // a lock — so the composer stays live. Only a thread that does not exist
  // and cannot be started has nowhere for a reply to go.
  const composerDisabled = missing && !canStart;
  const pending = sendReply.isPending || startThread.isPending;
  const sendError = sendReply.isError
    ? (sendReply.error as Error).message
    : startThread.isError
      ? (startThread.error as Error).message
      : null;

  const send = () => {
    const content = draft.trim();
    if (!content || pending || composerDisabled) return;
    if (canStart) {
      startThread.mutate(
        {
          key: threadKey,
          recipients: recipients as string[],
          content,
          ...(title ? { title } : {}),
          ...(studioSlug ? { studioSlug } : {}),
        },
        { onSuccess: () => setDraft('') }
      );
      return;
    }
    sendReply.mutate(content, { onSuccess: () => setDraft('') });
  };

  const renderItem = useCallback(({ item }: { item: TimelineItem }) => {
    if (item.type === 'day') return <DayDivider label={item.label} />;
    if (item.type === 'message') {
      return <MessageBubble message={item.message} continuation={item.continuation} />;
    }
    return null;
  }, []);

  const onEndReached = useCallback(() => {
    if (hasOlder && !loadingOlder) void loadOlder();
  }, [hasOlder, loadingOlder, loadOlder]);

  const thread = data?.thread;
  // Inverted list: the "footer" renders at the TOP, above the oldest message.
  const top = hasOlder ? (
    <Pressable
      onPress={() => void loadOlder()}
      disabled={loadingOlder}
      style={styles.loadEarlier}
      accessibilityRole="button"
      accessibilityLabel="Load earlier messages"
    >
      {loadingOlder ? (
        <ActivityIndicator color={colors.textSecondary} />
      ) : (
        <Text style={styles.loadEarlierText}>Load earlier messages</Text>
      )}
    </Pressable>
  ) : thread && history.messages.length > 0 ? (
    <View style={styles.intro}>
      <Text style={styles.introTitle}>{thread.title ?? threadKey}</Text>
      <Text style={styles.introLine}>
        This is the start of <Text style={styles.introKey}>{threadKey}</Text>
        {thread.createdBySlug ? `, opened by ${creatorLabel(thread.createdBySlug, nameFor)}` : ''}
        {thread.createdAt ? ` · ${formatDayLabel(thread.createdAt)}` : ''}
      </Text>
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      {historyError ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{historyError}</Text>
        </View>
      ) : null}

      <FlatList
        data={items}
        inverted
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={top}
        ListEmptyComponent={
          isLoading ? null : (
            <Text style={styles.empty}>
              {error
                ? (error as Error).message
                : canStart
                  ? `No thread yet. Your first message starts ${threadKey} with ${(recipients as string[]).join(', ')}.`
                  : missing
                    ? `There is no thread ${threadKey}.`
                    : 'No messages in this thread yet.'}
            </Text>
          )
        }
      />

      {closed ? (
        <View style={styles.closedBar}>
          <Text style={styles.closedText}>
            Thread is closed — a reply still lands and wakes its participants.
          </Text>
          <Pressable
            onPress={() => reopenThread.mutate()}
            disabled={reopenThread.isPending}
            style={({ pressed }) => [styles.reopenButton, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Reopen thread"
          >
            <Text style={styles.reopenText}>
              {reopenThread.isPending ? 'Reopening…' : 'Reopen'}
            </Text>
          </Pressable>
          {reopenThread.isError ? (
            <Text style={styles.errorText}>{(reopenThread.error as Error).message}</Text>
          ) : null}
        </View>
      ) : null}

      {sendError ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{sendError}</Text>
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder={
            canStart
              ? `Message ${title ?? recipients?.join(', ')}…`
              : composerDisabled
                ? 'This thread does not exist'
                : `Reply to ${threadKey}…`
          }
          placeholderTextColor={colors.textMuted}
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!pending && !composerDisabled}
        />
        <Pressable
          onPress={send}
          disabled={!draft.trim() || pending || composerDisabled}
          style={({ pressed }) => [
            styles.sendButton,
            (!draft.trim() || pending || composerDisabled) && styles.sendDisabled,
            pressed && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
          accessibilityLabel={canStart ? 'Start thread' : 'Send reply'}
        >
          <Text style={styles.sendText}>{pending ? '…' : canStart ? 'Start' : 'Send'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  listContent: { paddingBottom: spacing.md },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    marginHorizontal: spacing.lg,
    transform: [{ scaleY: -1 }],
  },
  loadEarlier: { alignItems: 'center', paddingVertical: spacing.lg, minHeight: 52 },
  loadEarlierText: { ...type.label, color: colors.accentBright },
  intro: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.sm },
  introTitle: { ...type.title, color: colors.textPrimary },
  introLine: { ...type.caption, color: colors.textSecondary, marginTop: 4, lineHeight: 17 },
  introKey: { ...type.mono, fontSize: 12, color: colors.textSecondary },
  closedBar: {
    paddingVertical: 6,
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.well,
  },
  closedText: { ...type.caption, color: colors.textMuted },
  reopenButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.textMuted,
  },
  reopenText: { ...type.caption, color: colors.textPrimary },
  errorBar: { paddingVertical: 6, paddingHorizontal: spacing.lg, backgroundColor: colors.well },
  errorText: { ...type.caption, color: colors.negative },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.well,
  },
  input: {
    ...type.body,
    flex: 1,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.sm + 2,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  sendDisabled: { backgroundColor: colors.surfaceOverlay },
  sendText: { ...type.title, fontSize: 15, color: colors.textPrimary },
});

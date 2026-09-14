import { useState } from 'react';
import {
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
import { MessageBubble } from '../components/MessageBubble';
import {
  useReopenThread,
  useSendReply,
  useStartThread,
  useThreadMessages,
} from '../hooks/useInkwell';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, type } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>;

/**
 * A thread, readable as chat. The list is INVERTED — newest at the bottom,
 * where the composer is — with the message array reversed to match; that's
 * what keeps the scroll position glued to the latest message across the 7s
 * polls without any scroll bookkeeping.
 */
export function ThreadScreen({ route }: Props) {
  const { threadKey, title, recipients, studioSlug } = route.params;
  const { data, isLoading, error } = useThreadMessages(threadKey);
  const sendReply = useSendReply(threadKey);
  const reopenThread = useReopenThread(threadKey);
  const startThread = useStartThread();
  const [draft, setDraft] = useState('');
  const headerHeight = useHeaderHeight();

  const messages = data?.messages ?? [];
  const inverted = [...messages].reverse();
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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <FlatList
        data={inverted}
        inverted
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.listContent}
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
        ListHeaderComponent={
          // Inverted list: the "header" renders at the BOTTOM, right above
          // the composer — where a truncation note belongs.
          data?.meta?.truncated ? (
            <Text style={styles.truncated}>
              Showing the latest {data.meta.fetched} of {data.meta.total} messages
            </Text>
          ) : null
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
  listContent: { paddingVertical: spacing.md },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    transform: [{ scaleY: -1 }],
  },
  truncated: {
    ...type.caption,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
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

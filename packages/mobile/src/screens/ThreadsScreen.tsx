import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { isConversation, matchesThreadSearch } from '@inklabs/shared/stories/thread-browsing';
import { formatShortAgo } from '@inklabs/shared/stories/thread-viewing';
import { ThreadRow } from '../components/ThreadRow';
import { useThreads } from '../hooks/useInkwell';
import { API_URL_HINT } from '../lib/api';
import type { ThreadSpine } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, type } from '../ui/theme';

/** The app shows SBs by slug; it loads no identities to name them otherwise. */
const nameFor = (sbSlug: string) => sbSlug;

/**
 * The thread list — the app's front door. Conversations with recent activity
 * first (the server already orders spines by lastActivityAt). A key that only
 * a session references has nothing to read, so it stays out of the list; the
 * shared browsing story decides that, and what the filter box matches: key,
 * title, summary, the newest message, or a participant. It doubles as "jump
 * to pr:545" for someone who knows exactly where they're going.
 */

/**
 * How often the relative timestamps ("4m", "3h") are recomputed.
 *
 * The finest bucket formatShortAgo produces is a minute, so ticking faster
 * cannot change a single label — it would only re-render the list for
 * nothing. Rows are memoised on the finished string, so a tick that changes
 * no label costs one cheap pass over the array and zero row renders.
 */
const CLOCK_TICK_MS = 60_000;

export function ThreadsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { data, isLoading, error, refetch } = useThreads();
  const [filter, setFilter] = useState('');

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  /**
   * Pull-to-refresh state, tracked here rather than taken from the query's
   * `isRefetching`.
   *
   * `isRefetching` is true for ANY refetch, including the 20s background
   * poll and the refetch on app focus — so binding the spinner to it made
   * the refresh indicator appear on its own every 20 seconds, which reads as
   * the app struggling rather than as polling working. The control should
   * answer "is the gesture you just made still running", and nothing else.
   */
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const onPullToRefresh = useCallback(() => {
    setPullRefreshing(true);
    // Settle the gesture whether the refetch resolves or rejects; an error is
    // reported by the notice above the list, not by a spinner that never stops.
    void refetch().finally(() => setPullRefreshing(false));
  }, [refetch]);

  const spines = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (data?.spines ?? []).filter(
      (spine) => isConversation(spine) && matchesThreadSearch(spine, needle, nameFor)
    );
  }, [data, filter]);

  // One callback for the whole list instead of one closure per row — a new
  // closure per row would change ThreadRow's props on every render and defeat
  // its memo entirely.
  const openThread = useCallback(
    (spine: ThreadSpine) => {
      navigation.navigate('Thread', {
        threadKey: spine.key,
        title: spine.thread?.title ?? undefined,
      });
    },
    [navigation]
  );

  const renderItem = useCallback(
    ({ item }: { item: ThreadSpine }) => (
      <ThreadRow
        spine={item}
        timeLabel={formatShortAgo(item.lastActivityAt, new Date(nowMs))}
        onPress={openThread}
      />
    ),
    [nowMs, openThread]
  );

  const keyExtractor = useCallback((s: ThreadSpine) => s.key, []);

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.filter}
        placeholder="Filter threads — pr:545, spec, wren…"
        placeholderTextColor={colors.textMuted}
        value={filter}
        onChangeText={setFilter}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      {error ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{(error as Error).message}</Text>
          {API_URL_HINT ? <Text style={styles.noticeHint}>{API_URL_HINT}</Text> : null}
        </View>
      ) : null}
      <FlatList
        data={spines}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={onPullToRefresh}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          isLoading ? null : (
            <Text style={styles.empty}>{filter ? 'No threads match.' : 'No threads yet.'}</Text>
          )
        }
        contentInsetAdjustmentBehavior="automatic"
        // Rows are variable height (title and summary are optional and wrap),
        // so getItemLayout would be a guess. These bound how many rows are
        // mounted, which is what an update has to walk.
        //
        // Deliberately NOT removeClippedSubviews: it is off by default on iOS
        // and can blank cells, and it addresses scroll cost — the measured
        // problem here was update cost on the 20s poll, which memoising the
        // row fixes. No reason to take a rendering risk for an unrelated win.
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={11}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  filter: {
    ...type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
  },
  notice: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.negative,
  },
  noticeText: { ...type.body, color: colors.negative },
  noticeHint: { ...type.caption, color: colors.textSecondary, marginTop: 4 },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl * 2,
  },
});

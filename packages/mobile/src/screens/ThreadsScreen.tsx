import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ThreadRow } from '../components/ThreadRow';
import { useThreads } from '../hooks/useInkwell';
import { API_URL_HINT } from '../lib/api';
import type { RootStackParamList } from '../navigation';
import { colors, spacing, type } from '../ui/theme';

/**
 * The thread list — the app's front door. Open threads with recent activity
 * first (the server already orders spines by lastActivityAt); a filter box
 * narrows by key, title, or participant, which doubles as "jump to pr:545"
 * for someone who knows exactly where they're going.
 */
export function ThreadsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { data, isLoading, error, refetch, isRefetching } = useThreads();
  const [filter, setFilter] = useState('');

  const spines = useMemo(() => {
    const all = data?.spines ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (s) =>
        s.key.toLowerCase().includes(needle) ||
        (s.thread?.title ?? '').toLowerCase().includes(needle) ||
        s.participants.some((p) => p.toLowerCase().includes(needle))
    );
  }, [data, filter]);

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
        keyExtractor={(s) => s.key}
        renderItem={({ item }) => (
          <ThreadRow
            spine={item}
            onPress={() =>
              navigation.navigate('Thread', {
                threadKey: item.key,
                title: item.thread?.title ?? undefined,
              })
            }
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.textSecondary}
          />
        }
        ListEmptyComponent={
          isLoading ? null : (
            <Text style={styles.empty}>{filter ? 'No threads match.' : 'No threads yet.'}</Text>
          )
        }
        contentInsetAdjustmentBehavior="automatic"
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

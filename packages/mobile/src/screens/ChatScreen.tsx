import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useIndividuals } from '../hooks/useInkwell';
import type { Individual } from '../lib/types';
import type { RootStackParamList } from '../navigation';
import { agentColor, colors, spacing, type } from '../ui/theme';

/**
 * Talk to an SB directly. Each row is a standing DM thread keyed
 * `chat:<agent>` — one per agent per account, so the conversation (and the
 * session the agent routes it to) carries on across days rather than
 * starting cold every time. The thread is created by the first message, not
 * by opening the row: looking is free.
 *
 * DMs pin to the agent's "main" studio: no studio declares a chat:* route
 * pattern, and an unrouted key is held, not delivered. Home is where you'd
 * expect to find someone you're just talking to.
 */
const DM_STUDIO_SLUG = 'main';
export function dmThreadKey(agentId: string): string {
  return `chat:${agentId}`;
}

function AgentRow({ agent }: { agent: Individual }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const hue = agentColor(agent.agentId);
  return (
    <Pressable
      onPress={() =>
        navigation.navigate('Thread', {
          threadKey: dmThreadKey(agent.agentId),
          title: agent.name,
          recipients: [agent.agentId],
          studioSlug: DM_STUDIO_SLUG,
        })
      }
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
    >
      <View style={[styles.avatar, { borderColor: hue }]}>
        <Text style={[styles.avatarText, { color: hue }]}>
          {agent.name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{agent.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {[agent.role, agent.backend].filter(Boolean).join(' · ') || agent.agentId}
        </Text>
      </View>
      <Text style={styles.key}>{dmThreadKey(agent.agentId)}</Text>
    </Pressable>
  );
}

export function ChatScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { data, isLoading, error, refetch, isRefetching } = useIndividuals();
  const agents = [...(data?.individuals ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <View style={styles.container}>
      <FlatList
        data={agents}
        keyExtractor={(a) => a.id}
        renderItem={({ item }) => <AgentRow agent={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={
          <Pressable
            onPress={() => navigation.navigate('NewThread')}
            style={({ pressed }) => [styles.newThread, pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
          >
            <Text style={styles.newThreadText}>New thread</Text>
            <Text style={styles.newThreadHint}>
              Pick a key and participants — a group, a PR, a spec
            </Text>
          </Pressable>
        }
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
              {error ? (error as Error).message : 'No SBs in this workspace yet.'}
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
  listContent: { paddingBottom: spacing.xl },
  newThread: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.accentDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    gap: 2,
  },
  newThreadText: { ...type.title, fontSize: 15, color: colors.accentBright },
  newThreadHint: { ...type.caption, color: colors.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 40 + spacing.md,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  avatarText: { ...type.title, fontSize: 16 },
  name: { ...type.title, fontSize: 15, color: colors.textPrimary },
  meta: { ...type.caption, color: colors.textMuted, marginTop: 1 },
  key: { ...type.mono, fontSize: 11, color: colors.textMuted },
  empty: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl * 2,
  },
});

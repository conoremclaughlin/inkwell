import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIndividuals, useStartThread } from '../hooks/useInkwell';
import type { RootStackParamList } from '../navigation';
import { agentColor, colors, spacing, type } from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'NewThread'>;

const KEY_SUGGESTIONS = ['thread:', 'pr:', 'spec:', 'issue:', 'debug:'];

/** Same grammar the server checks: <type>:<identifier>, no whitespace. */
export function isValidThreadKey(key: string): boolean {
  return /^[^\s:]+:[^\s]+$/.test(key.trim());
}

/**
 * Start a thread from the phone: a key, who is in it, an optional title, and
 * the first message. The key is typed rather than generated because the key
 * IS the routing — pr:557 lands with whoever holds that PR's studio, and a
 * made-up key would route nowhere in particular.
 */
export function NewThreadScreen({ navigation }: Props) {
  const individuals = useIndividuals();
  const startThread = useStartThread();
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const agents = useMemo(
    () => [...(individuals.data?.individuals ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [individuals.data]
  );

  const toggle = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const keyOk = isValidThreadKey(key);
  const canSubmit =
    keyOk && selected.size > 0 && content.trim().length > 0 && !startThread.isPending;

  const submit = () => {
    if (!canSubmit) return;
    const threadKey = key.trim();
    startThread.mutate(
      {
        key: threadKey,
        recipients: [...selected],
        content: content.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
      },
      {
        onSuccess: () =>
          navigation.replace('Thread', { threadKey, title: title.trim() || undefined }),
      }
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Thread key</Text>
        <TextInput
          style={[styles.input, styles.mono, key.length > 0 && !keyOk && styles.inputBad]}
          placeholder="pr:557"
          placeholderTextColor={colors.textMuted}
          value={key}
          onChangeText={setKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.chips}>
          {KEY_SUGGESTIONS.map((prefix) => (
            <Pressable
              key={prefix}
              onPress={() => setKey(prefix)}
              style={styles.chip}
              accessibilityRole="button"
            >
              <Text style={styles.chipText}>{prefix}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Participants</Text>
        {individuals.isLoading ? (
          <Text style={styles.caption}>Loading SBs…</Text>
        ) : (
          <View style={styles.chips}>
            {agents.map((agent) => {
              const on = selected.has(agent.agentId);
              const hue = agentColor(agent.agentId);
              return (
                <Pressable
                  key={agent.id}
                  onPress={() => toggle(agent.agentId)}
                  style={[
                    styles.agentChip,
                    on && { borderColor: hue, backgroundColor: colors.surfaceOverlay },
                  ]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.agentChipText, on && { color: hue }]}>{agent.name}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <Text style={styles.label}>Title (optional)</Text>
        <TextInput
          style={styles.input}
          placeholder="What this thread is about"
          placeholderTextColor={colors.textMuted}
          value={title}
          onChangeText={setTitle}
        />

        <Text style={styles.label}>First message</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Say what you need…"
          placeholderTextColor={colors.textMuted}
          value={content}
          onChangeText={setContent}
          multiline
        />

        {startThread.isError ? (
          <Text style={styles.error}>{(startThread.error as Error).message}</Text>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={({ pressed }) => [
            styles.button,
            !canSubmit && styles.buttonDisabled,
            pressed && { opacity: 0.8 },
          ]}
          accessibilityRole="button"
        >
          {startThread.isPending ? (
            <ActivityIndicator color={colors.textPrimary} />
          ) : (
            <Text style={styles.buttonText}>Start thread</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  label: {
    ...type.label,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: spacing.md,
  },
  caption: { ...type.caption, color: colors.textMuted },
  input: {
    ...type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  inputBad: { borderColor: colors.negative },
  mono: { ...type.mono, fontSize: 15 },
  multiline: { minHeight: 100, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  chipText: { ...type.mono, fontSize: 12, color: colors.textSecondary },
  agentChip: {
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: colors.borderDefault,
    backgroundColor: colors.surface,
  },
  agentChipText: { ...type.label, fontSize: 13, color: colors.textSecondary },
  error: { ...type.body, color: colors.negative },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  buttonDisabled: { backgroundColor: colors.surfaceOverlay },
  buttonText: { ...type.title, color: colors.textPrimary },
});

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSwitchWorkspace, useWorkspaces } from '../hooks/useInkwell';
import { API_URL_SOURCE, AUTO_API_BASE_URL, apiBaseUrl, logout } from '../lib/api';
import { getAuthState } from '../lib/auth';
import {
  getServerUrlOverride,
  getWorkspaceId,
  setServerUrlOverride,
  subscribeWorkspace,
} from '../lib/storage';
import { colors, spacing, type } from '../ui/theme';

/**
 * Account, workspace, server. The workspace picker lives here rather than in
 * a header menu because switching is rare and consequential — every list in
 * the app changes — and a deliberate screen makes that legible.
 */
export function SettingsScreen() {
  const { email } = getAuthState();
  const [serverUrl, setServerUrl] = useState(getServerUrlOverride() ?? '');
  const [saved, setSaved] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState(getWorkspaceId());
  const workspaces = useWorkspaces();
  const switchWorkspace = useSwitchWorkspace();

  useEffect(() => subscribeWorkspace(setSelectedWorkspace), []);

  const saveServer = async () => {
    await setServerUrlOverride(serverUrl || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // Null selection means "server default"; the server tells us which one that
  // resolved to, so the default row can be marked without guessing.
  const activeId = selectedWorkspace ?? workspaces.data?.currentWorkspaceId ?? null;
  const list = (workspaces.data?.workspaces ?? []).filter((w) => !w.archivedAt);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.card}>
        <Text style={styles.value}>{email ?? 'Signed in'}</Text>
        <Pressable onPress={() => void logout()} hitSlop={8} accessibilityRole="button">
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Workspace</Text>
      <View style={[styles.card, { gap: 0, paddingVertical: spacing.xs }]}>
        {workspaces.isLoading ? (
          <Text style={[styles.caption, { paddingVertical: spacing.sm }]}>Loading…</Text>
        ) : workspaces.error ? (
          <Text style={[styles.caption, { color: colors.negative, paddingVertical: spacing.sm }]}>
            {(workspaces.error as Error).message}
          </Text>
        ) : (
          list.map((w, i) => {
            const selected = w.id === activeId;
            return (
              <Pressable
                key={w.id}
                onPress={() => switchWorkspace.mutate(w.id)}
                style={[styles.workspaceRow, i > 0 && styles.workspaceRowBorder]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
              >
                <View style={[styles.radio, selected && styles.radioSelected]}>
                  {selected ? <View style={styles.radioDot} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.value}>{w.name}</Text>
                  <Text style={styles.caption}>{[w.type, w.role].filter(Boolean).join(' · ')}</Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>
      {switchWorkspace.error ? (
        <Text style={[styles.caption, { color: colors.negative }]}>
          {(switchWorkspace.error as Error).message}
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>Server</Text>
      <View style={styles.card}>
        <Text style={styles.caption}>
          Leave blank to auto-detect ({API_URL_SOURCE}: {AUTO_API_BASE_URL}). Currently using{' '}
          {apiBaseUrl()}.
        </Text>
        <TextInput
          style={styles.input}
          placeholder="https://inkwell.example.com"
          placeholderTextColor={colors.textMuted}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Pressable onPress={saveServer} style={styles.saveButton} accessibilityRole="button">
          <Text style={styles.saveText}>{saved ? 'Saved' : 'Save'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl * 2 },
  sectionTitle: {
    ...type.label,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginTop: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    gap: spacing.md,
  },
  value: { ...type.body, color: colors.textPrimary },
  caption: { ...type.caption, color: colors.textSecondary, lineHeight: 17 },
  signOut: { ...type.body, color: colors.negative },
  workspaceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  workspaceRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.accentBright },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accentBright },
  input: {
    ...type.body,
    color: colors.textPrimary,
    backgroundColor: colors.well,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  saveButton: {
    backgroundColor: colors.accentDim,
    borderRadius: 8,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  saveText: { ...type.title, fontSize: 14, color: colors.accentBright },
});

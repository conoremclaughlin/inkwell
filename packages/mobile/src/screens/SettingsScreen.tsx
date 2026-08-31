import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { API_URL_SOURCE, AUTO_API_BASE_URL, apiBaseUrl, logout } from '../lib/api';
import { getAuthState } from '../lib/auth';
import { getServerUrlOverride, setServerUrlOverride } from '../lib/storage';
import { colors, spacing, type } from '../ui/theme';

export function SettingsScreen() {
  const { email } = getAuthState();
  const [serverUrl, setServerUrl] = useState(getServerUrlOverride() ?? '');
  const [saved, setSaved] = useState(false);

  const saveServer = async () => {
    await setServerUrlOverride(serverUrl || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Account</Text>
      <View style={styles.card}>
        <Text style={styles.value}>{email ?? 'Signed in'}</Text>
        <Pressable onPress={() => void logout()} hitSlop={8} accessibilityRole="button">
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>

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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink, padding: spacing.lg, gap: spacing.sm },
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

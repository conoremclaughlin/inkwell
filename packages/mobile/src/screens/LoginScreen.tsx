import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { API_URL_HINT, apiBaseUrl, login } from '../lib/api';
import { setServerUrlOverride } from '../lib/storage';
import { colors, spacing, type } from '../ui/theme';

/**
 * Email + password against the same account the dashboard uses. The server
 * URL is exposed here too (not only in Settings) because a physical device
 * that can't reach the API fails AT login — the fix belongs where the
 * failure is.
 */
export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await setServerUrlOverride(serverUrl || null);
      await login(email.trim(), password);
      // Success flips auth state; App.tsx swaps the navigator.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.wordmark}>Inkwell</Text>
        <Text style={styles.subtitle}>Your threads, on the go</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textMuted}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          onSubmitEditing={submit}
        />

        {showServer ? (
          <TextInput
            style={styles.input}
            placeholder={`Server URL (auto: ${apiBaseUrl()})`}
            placeholderTextColor={colors.textMuted}
            value={serverUrl}
            onChangeText={setServerUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        ) : (
          <Pressable onPress={() => setShowServer(true)} hitSlop={8}>
            <Text style={styles.serverToggle}>Server: {apiBaseUrl()} — change</Text>
          </Pressable>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {error && API_URL_HINT ? <Text style={styles.hint}>{API_URL_HINT}</Text> : null}

        <Pressable
          onPress={submit}
          disabled={busy || !email.trim() || !password}
          style={({ pressed }) => [
            styles.button,
            (busy || !email.trim() || !password) && styles.buttonDisabled,
            pressed && { opacity: 0.8 },
          ]}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color={colors.textPrimary} />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.ink,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: { gap: spacing.md },
  wordmark: { fontSize: 34, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  subtitle: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  input: {
    ...type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  serverToggle: { ...type.caption, color: colors.textMuted, textAlign: 'center' },
  error: { ...type.body, color: colors.negative, textAlign: 'center' },
  hint: { ...type.caption, color: colors.textSecondary, textAlign: 'center' },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: { backgroundColor: colors.surfaceOverlay },
  buttonText: { ...type.title, color: colors.textPrimary },
});

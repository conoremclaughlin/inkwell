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
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { apiBaseUrl, signup } from '../lib/api';
import type { AuthStackParamList } from '../navigation';
import { colors, spacing, type } from '../ui/theme';

/** Same checklist the dashboard shows; the server enforces the same rules. */
const PASSWORD_RULES: Array<{ label: string; test: (pw: string) => boolean }> = [
  { label: 'At least 8 characters', test: (pw) => pw.length >= 8 },
  { label: 'Contains a number', test: (pw) => /\d/.test(pw) },
  { label: 'Contains a letter', test: (pw) => /[a-zA-Z]/.test(pw) },
];

export function SignUpScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AuthStackParamList>>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const checks = useMemo(
    () => PASSWORD_RULES.map((rule) => ({ ...rule, met: rule.test(password) })),
    [password]
  );
  const rulesMet = checks.every((c) => c.met);
  const matches = password.length > 0 && password === confirm;
  const canSubmit = email.trim().length > 0 && rulesMet && matches && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signup(email.trim(), password);
      if (result.confirmationRequired) setSentTo(result.email);
      // Otherwise auth state flipped and App.tsx swaps the navigator.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign up failed');
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.heading}>Check your email</Text>
        <Text style={styles.body}>
          If {sentTo} is new to Inkwell, a confirmation link is on its way. Open it, then come back
          and sign in. Already have an account? Just sign in.
        </Text>
        <Pressable
          onPress={() => navigation.navigate('Login')}
          style={styles.button}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Go to sign in</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
          textContentType="newPassword"
        />
        {password.length > 0 ? (
          <View style={styles.rules}>
            {checks.map((c) => (
              <Text
                key={c.label}
                style={[styles.rule, { color: c.met ? colors.positive : colors.textMuted }]}
              >
                {c.met ? '✓' : '○'} {c.label}
              </Text>
            ))}
          </View>
        ) : null}
        <TextInput
          style={styles.input}
          placeholder="Confirm password"
          placeholderTextColor={colors.textMuted}
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          textContentType="newPassword"
          onSubmitEditing={submit}
        />
        {confirm.length > 0 && !matches ? (
          <Text style={styles.error}>Passwords don’t match</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

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
          {busy ? (
            <ActivityIndicator color={colors.textPrimary} />
          ) : (
            <Text style={styles.buttonText}>Create account</Text>
          )}
        </Pressable>
        <Text style={styles.caption}>Account created on {apiBaseUrl()}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  centered: { justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  content: { padding: spacing.xl, gap: spacing.md },
  heading: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  body: { ...type.body, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  input: {
    ...type.body,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rules: { gap: 2, paddingHorizontal: spacing.xs },
  rule: { ...type.caption, fontSize: 13 },
  error: { ...type.body, color: colors.negative, textAlign: 'center' },
  caption: { ...type.caption, color: colors.textMuted, textAlign: 'center' },
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

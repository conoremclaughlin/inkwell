import { useCallback, useRef, useState } from 'react';
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
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { claimPairingCode } from '../lib/api';
import { parsePairingInput } from '../lib/pairing';
import { colors, spacing, type } from '../ui/theme';

/**
 * Pair with the dashboard: point the camera at the QR on the Mobile page, or
 * type the code shown under it. The scan path also picks the server URL from
 * the payload, so a fresh install needs no configuration at all; the typed
 * path claims against the app's current server (Settings, or autodetected).
 *
 * Multiple frames of the same QR arrive in quick succession — a ref, not
 * state, gates the first claim so re-renders can't let a second one through.
 */
export function ConnectScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claimingRef = useRef(false);

  const claim = useCallback(async (raw: string) => {
    if (claimingRef.current) return;
    const payload = parsePairingInput(raw);
    if (!payload) {
      setError("That isn't an Inkwell pairing code.");
      return;
    }
    claimingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await claimPairingCode(payload);
      // Success flips auth state; App.tsx swaps the navigator.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pairing failed');
      claimingRef.current = false;
    } finally {
      setBusy(false);
    }
  }, []);

  const onScanned = useCallback(
    (result: BarcodeScanningResult) => {
      // Ignore QR codes that aren't ours instead of erroring on every frame.
      if (!claimingRef.current && parsePairingInput(result.data)) void claim(result.data);
    },
    [claim]
  );

  const cameraGranted = permission?.granted === true;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.viewfinder}>
        {cameraGranted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={busy ? undefined : onScanned}
          />
        ) : (
          <View style={styles.permission}>
            <Text style={styles.permissionText}>
              {permission?.canAskAgain === false
                ? 'Camera access is off for Inkwell. Enable it in Settings, or type the code below.'
                : 'Scan the QR on your dashboard’s Mobile page.'}
            </Text>
            {permission && permission.canAskAgain !== false ? (
              <Pressable
                onPress={() => void requestPermission()}
                style={styles.secondaryButton}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryText}>Allow camera</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        {busy ? (
          <View style={styles.busyOverlay}>
            <ActivityIndicator color={colors.textPrimary} />
            <Text style={styles.busyText}>Pairing…</Text>
          </View>
        ) : null}
        <View style={styles.frame} pointerEvents="none" />
      </View>

      <View style={styles.form}>
        <Text style={styles.caption}>Can’t scan? Type the code shown under the QR.</Text>
        <TextInput
          style={styles.input}
          placeholder="ABCD-EFGH-JKLM"
          placeholderTextColor={colors.textMuted}
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={() => void claim(typed)}
          editable={!busy}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          onPress={() => void claim(typed)}
          disabled={busy || !typed.trim()}
          style={({ pressed }) => [
            styles.button,
            (busy || !typed.trim()) && styles.buttonDisabled,
            pressed && { opacity: 0.8 },
          ]}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Use code</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.ink },
  viewfinder: {
    flex: 1,
    margin: spacing.lg,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.well,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.accentBright,
    opacity: 0.85,
  },
  permission: { padding: spacing.xl, alignItems: 'center', gap: spacing.md },
  permissionText: {
    ...type.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
  },
  busyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(11,14,20,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  busyText: { ...type.body, color: colors.textPrimary },
  form: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm },
  caption: { ...type.caption, color: colors.textMuted },
  input: {
    ...type.mono,
    fontSize: 18,
    letterSpacing: 2,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    textAlign: 'center',
  },
  error: { ...type.caption, fontSize: 13, color: colors.negative, textAlign: 'center' },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: colors.surfaceOverlay },
  buttonText: { ...type.title, color: colors.textPrimary },
  secondaryButton: {
    backgroundColor: colors.accentDim,
    borderRadius: 8,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
  },
  secondaryText: { ...type.title, fontSize: 14, color: colors.accentBright },
});

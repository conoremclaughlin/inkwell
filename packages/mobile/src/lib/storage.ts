/**
 * Non-secret preferences. The server URL override lives here (AsyncStorage),
 * NOT in the keychain — it's configuration, not a credential, and it needs a
 * synchronous read on the request path, so it's mirrored in memory and loaded
 * once at startup.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = 'inkwell.serverUrl';

let serverUrlOverride: string | null = null;
let loaded = false;

export async function loadPreferences(): Promise<void> {
  if (loaded) return;
  try {
    serverUrlOverride = await AsyncStorage.getItem(SERVER_URL_KEY);
  } catch {
    serverUrlOverride = null;
  }
  loaded = true;
}

export function getServerUrlOverride(): string | null {
  return serverUrlOverride;
}

export async function setServerUrlOverride(url: string | null): Promise<void> {
  serverUrlOverride = url && url.trim() ? url.trim().replace(/\/+$/, '') : null;
  if (serverUrlOverride) {
    await AsyncStorage.setItem(SERVER_URL_KEY, serverUrlOverride);
  } else {
    await AsyncStorage.removeItem(SERVER_URL_KEY);
  }
}

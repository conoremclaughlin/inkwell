/**
 * Non-secret preferences: the server URL override and the selected workspace.
 * Both live in AsyncStorage, NOT the keychain — they're configuration, not
 * credentials — and both need a synchronous read on the request path, so
 * they're mirrored in memory and loaded once at startup.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL_KEY = 'inkwell.serverUrl';
const WORKSPACE_ID_KEY = 'inkwell.workspaceId';

let serverUrlOverride: string | null = null;
let workspaceId: string | null = null;
let loaded = false;

const workspaceListeners = new Set<(id: string | null) => void>();

export async function loadPreferences(): Promise<void> {
  if (loaded) return;
  try {
    [serverUrlOverride, workspaceId] = await Promise.all([
      AsyncStorage.getItem(SERVER_URL_KEY),
      AsyncStorage.getItem(WORKSPACE_ID_KEY),
    ]);
  } catch {
    serverUrlOverride = null;
    workspaceId = null;
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

/**
 * The workspace every request is scoped to (sent as x-ink-workspace-id).
 * Null means "the server's default for this user" — the personal workspace.
 */
export function getWorkspaceId(): string | null {
  return workspaceId;
}

export function subscribeWorkspace(listener: (id: string | null) => void): () => void {
  workspaceListeners.add(listener);
  return () => workspaceListeners.delete(listener);
}

export async function setWorkspaceId(id: string | null): Promise<void> {
  workspaceId = id && id.trim() ? id.trim() : null;
  for (const listener of workspaceListeners) listener(workspaceId);
  if (workspaceId) {
    await AsyncStorage.setItem(WORKSPACE_ID_KEY, workspaceId);
  } else {
    await AsyncStorage.removeItem(WORKSPACE_ID_KEY);
  }
}

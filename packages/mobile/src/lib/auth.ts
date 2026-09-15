/**
 * Token storage and the login/refresh/logout lifecycle.
 *
 * Tokens live in the OS keychain (expo-secure-store), not AsyncStorage: the
 * refresh token is a 90-day credential to everything the dashboard can see.
 * The module holds an in-memory copy so request paths never await the
 * keychain, and notifies subscribers (App.tsx) when auth state flips so the
 * navigator can swap between Login and the main tabs.
 */
import * as SecureStore from 'expo-secure-store';
import type { LoginResponse, RefreshResponse } from './types';

const ACCESS_KEY = 'inkwell.accessToken';
const REFRESH_KEY = 'inkwell.refreshToken';
const EMAIL_KEY = 'inkwell.email';

export interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  email: string | null;
}

let state: AuthState = { accessToken: null, refreshToken: null, email: null };
let loaded = false;
const listeners = new Set<(s: AuthState) => void>();

function notify() {
  for (const listener of listeners) listener(state);
}

export function subscribeAuth(listener: (s: AuthState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthState(): AuthState {
  return state;
}

export function isLoggedIn(): boolean {
  return !!state.refreshToken;
}

/** Load persisted tokens once at startup. Safe to call repeatedly. */
export async function loadAuth(): Promise<AuthState> {
  if (loaded) return state;
  try {
    const [accessToken, refreshToken, email] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
      SecureStore.getItemAsync(EMAIL_KEY),
    ]);
    state = { accessToken, refreshToken, email };
  } catch {
    // Keychain unavailable (fresh simulator, device policy) — start signed out.
    state = { accessToken: null, refreshToken: null, email: null };
  }
  loaded = true;
  notify();
  return state;
}

export async function storeLogin(login: LoginResponse): Promise<void> {
  state = { accessToken: login.accessToken, refreshToken: login.refreshToken, email: login.email };
  loaded = true;
  notify();
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, login.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, login.refreshToken),
    SecureStore.setItemAsync(EMAIL_KEY, login.email),
  ]);
}

export async function storeRefreshedAccess(refreshed: RefreshResponse): Promise<void> {
  state = { ...state, accessToken: refreshed.accessToken };
  notify();
  await SecureStore.setItemAsync(ACCESS_KEY, refreshed.accessToken);
}

export async function clearAuth(): Promise<void> {
  state = { accessToken: null, refreshToken: null, email: null };
  notify();
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
    SecureStore.deleteItemAsync(EMAIL_KEY),
  ]);
}

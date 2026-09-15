import type { NavigatorScreenParams } from '@react-navigation/native';

/** Signed-out world: three ways in. */
export type AuthStackParamList = {
  Login: undefined;
  SignUp: undefined;
  Connect: undefined;
};

export type TabParamList = {
  Threads: undefined;
  Chat: undefined;
  Fleet: undefined;
};

/**
 * Thread and Settings are stack routes above the tabs: a thread is a place
 * you drill into from the list (or arrive at cold from a notification later),
 * and Settings is reachable from every tab's header rather than spending a
 * permanent tab on it.
 */
export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  /**
   * `recipients` makes the screen able to START the thread if the key does
   * not exist yet (a DM's first message); without it, an unknown key is
   * read-only — replying into nowhere is how typos become threads.
   */
  Thread: { threadKey: string; title?: string; recipients?: string[]; studioSlug?: string };
  Session: { sessionId: string; title?: string };
  NewThread: undefined;
  Settings: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}

const STORAGE_KEY = 'ink:selectedWorkspaceId';
// Written by every build before #659. Read once so an existing selection
// survives the rename, then retired on the next write.
const LEGACY_STORAGE_KEY = 'pcp:selectedWorkspaceId';

export function getSelectedWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY)
  );
}

export function setSelectedWorkspaceId(workspaceId: string | null): void {
  if (typeof window === 'undefined') return;

  window.localStorage.removeItem(LEGACY_STORAGE_KEY);

  if (!workspaceId) {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, workspaceId);
  }
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

/**
 * Hear about a workspace switch, in this tab or another. A view that holds
 * data across renders (an open thread's history) must start over when the
 * workspace changes, because the same key can name another thread there.
 */
export function subscribeSelectedWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

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
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, workspaceId);
}

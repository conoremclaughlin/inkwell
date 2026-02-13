const STORAGE_KEY = 'pcp:selectedWorkspaceId';

export function getSelectedWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setSelectedWorkspaceId(workspaceId: string | null): void {
  if (typeof window === 'undefined') return;

  if (!workspaceId) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, workspaceId);
}

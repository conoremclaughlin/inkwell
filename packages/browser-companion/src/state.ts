import type { BrowserSnapshot, FillProposal } from './protocol';

export interface CompanionState {
  sourceTabId?: number;
  documentId?: string;
  snapshot?: BrowserSnapshot;
  proposal?: FillProposal;
  dashboardOrigin?: string;
  dashboardTabId?: number;
  dashboardDocumentId?: string;
  bridgeId?: string;
}

export interface Reply<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export async function panelRequest<T>(message: Record<string, unknown>): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'The companion could not complete this action.');
  return reply.value as T;
}

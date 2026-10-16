import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../data/supabase/types';
import { INKLING_CLIENT } from './inklings/inkling-client';

export interface BrowserChatRecipient {
  id: string;
  sbSlug: string;
  displayName: string;
}

export class BrowserRecipientRefusedError extends Error {
  constructor() {
    super('browser_recipient_not_available');
  }
}

/** Explicit pairing can name one of the user's ordinary hosted companions.
 * App inklings retain their existing owner-test/lineage path; this is not a
 * way to reclassify one or to select a CLI runtime from a browser credential. */
export async function browserChatRecipients(
  client: SupabaseClient<Database>,
  scope: { userId: string; workspaceId: string },
  recipientId?: string
): Promise<BrowserChatRecipient[]> {
  let query = client
    .from('agent_identities')
    .select('id, agent_id, name, metadata')
    .eq('user_id', scope.userId)
    .eq('workspace_id', scope.workspaceId)
    .eq('backend', 'ink');
  if (recipientId !== undefined) query = query.eq('id', recipientId);
  const { data, error } = await query.order('id').limit(recipientId ? 1 : 100);
  if (error) throw new Error('browser_recipients_unavailable');
  return (data ?? [])
    .filter((row) => {
      const metadata = row.metadata;
      return !(
        metadata &&
        typeof metadata === 'object' &&
        !Array.isArray(metadata) &&
        metadata.client === INKLING_CLIENT
      );
    })
    .map((row) => ({ id: row.id, sbSlug: row.agent_id, displayName: row.name }));
}

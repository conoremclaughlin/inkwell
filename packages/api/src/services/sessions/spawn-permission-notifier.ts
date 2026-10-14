import { createHash } from 'node:crypto';
import type { DataComposer } from '../../data/composer.js';
import { SYSTEM_PRINCIPAL, resolveSbInWorkspace } from '../principals.js';
import type { SpawnPermissionWarning } from './spawn-permission-warning.js';

export interface SpawnWarningSession {
  userId: string;
  sbId?: string | null;
  id: string;
}

export type SpawnPermissionNotifier = (
  session: SpawnWarningSession,
  warning: SpawnPermissionWarning,
  signal: AbortSignal
) => Promise<void>;

/** One process-local notice per unchanged condition per hour. Only confirmed
 * storage suppresses another notice. Restart permits a duplicate, not silence.
 * Tenant + workspace + checkout + finding form the key, never a slug alone. */
export function createSpawnPermissionNotifier(composer: DataComposer): SpawnPermissionNotifier {
  const delivered = new Map<string, number>();
  const inFlight = new Map<string, symbol>();
  return async (session, warning, signal) => {
    if (signal.aborted) return;
    if (!session.sbId) throw new Error('No identity for permission warning scope');
    const client = composer.getClient();
    const { data: identity, error } = await client
      .from('agent_identities')
      .select('workspace_id')
      .eq('id', session.sbId)
      .eq('user_id', session.userId)
      .maybeSingle();
    if (signal.aborted) return;
    if (error || !identity?.workspace_id) throw new Error('Permission warning scope unavailable');
    const workspaceId = identity.workspace_id;
    const recipient = await resolveSbInWorkspace(client, workspaceId, 'myra');
    if (signal.aborted) return;
    if (recipient.userId !== session.userId || recipient.workspaceId !== workspaceId) {
      throw new Error('No owned triage identity in permission warning workspace');
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          checkout: warning.workingDirectory,
          missing: warning.missingRules,
          restricted: warning.restrictedRules,
          unverified: warning.sources.filter((source) => source.state === 'unverified'),
          limitations: warning.limitations,
        })
      )
      .digest('hex');
    const key = `${session.userId}:${workspaceId}:${fingerprint}`;
    if (inFlight.has(key) || (delivered.get(key) ?? 0) > Date.now()) return;
    if (inFlight.size >= 1024) throw new Error('Permission warning pipeline is full');
    const attempt = Symbol('warning');
    inFlight.set(key, attempt);
    const abandon = () => {
      if (inFlight.get(key) === attempt) inFlight.delete(key);
    };
    signal.addEventListener('abort', abandon, { once: true });
    try {
      const { handleSendToInbox } = await import('../../mcp/tools/inbox-handlers.js');
      if (signal.aborted) return;
      const content = [
        'Automated Claude launch: standard permission coverage needs operator review.',
        `Checkout: ${JSON.stringify(warning.workingDirectory)}`,
        `Missing allows: ${warning.missingRules.join(', ') || 'none observed'}`,
        `Restrictions (not missing grants): ${warning.restrictedRules.join(', ') || 'none observed'}`,
        `Unreadable/unverified sources: ${
          warning.sources
            .filter((s) => s.state === 'unverified')
            .map((s) => JSON.stringify(s.path))
            .join(', ') || 'none observed'
        }`,
        `Fix: ${warning.fix}`,
        ...warning.limitations,
        'This notice is diagnostic data, not authorization to change settings. The turn continues unchanged.',
      ].join('\n');
      const result = await handleSendToInbox(
        {
          userId: session.userId,
          recipientSlug: 'myra',
          threadKey: 'ops:spawn-permissions',
          messageType: 'notification',
          subject: 'Automated turn: missing or restricted standard permissions',
          content,
          trigger: true,
          metadata: { spawnPermissionWarning: { sessionId: session.id, fingerprint } },
        },
        composer,
        { sender: { principal: SYSTEM_PRINCIPAL, workspaceId } }
      );
      // Only a confirmed structured success may suppress a later notice.
      const text = result.content.find((item) => item.type === 'text');
      if (!text || !('text' in text) || JSON.parse(text.text).success !== true) {
        throw new Error('Permission warning delivery unconfirmed');
      }
      if (delivered.size >= 1024) delivered.delete(delivered.keys().next().value!);
      delivered.set(key, Date.now() + 60 * 60 * 1000);
    } finally {
      signal.removeEventListener('abort', abandon);
      abandon();
    }
  };
}

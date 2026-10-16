/**
 * A member's own calendar sharing in a space: the "share my busy times here"
 * switch (ink://specs/inkling-multi-person-groups D6).
 *
 * Mounted by routes/admin.ts after admin auth.
 *
 *   GET /api/admin/workspaces/:workspaceId/calendar-share
 *     → 200 { level: 'none' | 'busy', calendarConnected: boolean | null }
 *   PUT /api/admin/workspaces/:workspaceId/calendar-share { level: 'none' | 'busy' }
 *     → 200 { level }
 *
 * Both read and write the signed-in person's own membership row and no other:
 * the row is found by their own user id, so no one sets another member's level,
 * an owner or admin included. Not a member of the space: 404. Every member
 * starts at 'none', and connecting a calendar changes nothing here.
 *
 * `calendarConnected` says whether the space's SB could read this person's
 * free/busy at all (a stored Google connection with a calendar scope, or a
 * credential the server holds for them), so the app can point to Connectors.
 * Null when that couldn't be read.
 */
import { Router, type Request, type Response } from 'express';
import { getDataComposer } from '../data/composer';
import { getOAuthService } from '../services/oauth';
import {
  canReadFreeBusy,
  freeBusyConnection,
  isCalendarShareLevel,
} from '../stories/google-calendar/space-busy-times';
import { logger } from '../utils/logger';

type SignedIn = Request & { inkUserId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = '/workspaces/:workspaceId/calendar-share';
const NOT_A_MEMBER = { error: 'Space not found', code: 'not_a_member' };

/** Whether the space's SB could read this person's free/busy; null when unknown. */
async function calendarConnected(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { from: (table: string) => any },
  userId: string,
  workspaceId: string
): Promise<boolean | null> {
  try {
    if ((await freeBusyConnection(client, userId, workspaceId)).found) return true;
    const oauth = getOAuthService();
    if (!oauth.getCredentialSources().includes('desktop')) return false;
    const desktop = await oauth.describeDesktopCredentials(userId);
    if (desktop.error) return null;
    return desktop.credentials.some(
      (credential) => credential.state !== 'unusable' && canReadFreeBusy(credential.scopes)
    );
  } catch {
    return null;
  }
}

export const calendarShareRouter: Router = Router();

calendarShareRouter.get(PATH, async (req: Request, res: Response) => {
  try {
    const { inkUserId } = req as SignedIn;
    const { workspaceId } = req.params;
    res.setHeader('Cache-Control', 'no-store');
    if (!UUID.test(workspaceId)) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    const client = (await getDataComposer()).getClient();
    const { data, error } = await client
      .from('workspace_members')
      .select('calendar_share')
      .eq('workspace_id', workspaceId)
      .eq('user_id', inkUserId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    const level = isCalendarShareLevel(data.calendar_share) ? data.calendar_share : 'none';
    res.json({ level, calendarConnected: await calendarConnected(client, inkUserId, workspaceId) });
  } catch (error) {
    logger.error('Calendar sharing: failed to read', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Failed to read calendar sharing' });
  }
});

calendarShareRouter.put(PATH, async (req: Request, res: Response) => {
  try {
    const { inkUserId } = req as SignedIn;
    const { workspaceId } = req.params;
    res.setHeader('Cache-Control', 'no-store');
    const level: unknown = (req.body as { level?: unknown } | undefined)?.level;
    if (!isCalendarShareLevel(level)) {
      res.status(400).json({ error: "level must be 'none' or 'busy'", code: 'invalid_level' });
      return;
    }
    if (!UUID.test(workspaceId)) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    const client = (await getDataComposer()).getClient();
    const { data, error } = await client
      .from('workspace_members')
      .update({ calendar_share: level })
      .eq('workspace_id', workspaceId)
      .eq('user_id', inkUserId)
      .select('calendar_share');
    if (error) throw error;
    const row = (data ?? [])[0];
    if (!row) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    logger.info('Calendar sharing changed', { workspaceId, level });
    res.json({ level: row.calendar_share });
  } catch (error) {
    logger.error('Calendar sharing: failed to change', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Failed to change calendar sharing' });
  }
});

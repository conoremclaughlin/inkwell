/**
 * A member's own calendar sharing in a space: the "share my busy times here"
 * switch (ink://specs/inkling-multi-person-groups D6).
 *
 * Mounted by routes/admin.ts after admin auth.
 *
 *   GET /api/admin/workspaces/:workspaceId/calendar-share
 *     → 200 { level: 'none' | 'busy', calendarConnected: boolean | null, revision }
 *   PUT /api/admin/workspaces/:workspaceId/calendar-share
 *       { level: 'none' | 'busy', ifRevision }
 *     → 200 { level, revision }
 *     → 409 { code: 'revision_changed', level, revision } when ifRevision isn't current
 *
 * Both read and write the signed-in person's own membership row and no other:
 * the row is found by their own user id, so no one sets another member's level,
 * an owner or admin included. Not a member of the space: 404. Every member
 * starts at 'none', and connecting a calendar changes nothing here.
 *
 * A change is made only from the revision the person last read. A revision
 * is opaque to clients and names both the membership row and its version
 * (`<membership id>.<version>`): one UPDATE matches that row at that version
 * and sets the next version, so of two writes sent from the same revision
 * exactly one applies, and a write read from one membership never lands on a
 * later one (leaving and rejoining makes a new row, whose version starts at 0
 * again). A grant whose answer was lost can then never land after a later
 * change the app saw confirmed (Lumen's review of the app's switch). Every
 * acknowledged write moves the revision, one that keeps the level included.
 * `ifRevision` is required: there is no unfenced write.
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

const SHARE_COLUMNS = 'id, calendar_share, calendar_share_version';

interface ShareRow {
  id: string;
  calendar_share: string | null;
  calendar_share_version: number | null;
}

/** A membership row and the version of its sharing, as one opaque token. */
export function revisionOf(row: Pick<ShareRow, 'id' | 'calendar_share_version'>): string {
  return `${row.id}.${row.calendar_share_version ?? 0}`;
}

const REVISION =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9][0-9]{0,15})$/i;

/** The row and version a revision names, or null for anything that isn't one. */
export function parseRevision(value: unknown): { membershipId: string; version: number } | null {
  if (typeof value !== 'string') return null;
  const match = REVISION.exec(value);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return null;
  return { membershipId: match[1].toLowerCase(), version };
}

/** The level and revision a row holds, as the routes answer them. */
function shareOf(row: ShareRow): { level: 'none' | 'busy'; revision: string } {
  return {
    level: isCalendarShareLevel(row.calendar_share) ? row.calendar_share : 'none',
    revision: revisionOf(row),
  };
}

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
      .select(SHARE_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('user_id', inkUserId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    const { level, revision } = shareOf(data as ShareRow);
    res.json({
      level,
      calendarConnected: await calendarConnected(client, inkUserId, workspaceId),
      revision,
    });
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
    const body = req.body as { level?: unknown; ifRevision?: unknown } | undefined;
    const level = body?.level;
    const read = parseRevision(body?.ifRevision);
    if (!isCalendarShareLevel(level)) {
      res.status(400).json({ error: "level must be 'none' or 'busy'", code: 'invalid_level' });
      return;
    }
    if (!read) {
      res.status(400).json({
        error: 'ifRevision must be the revision last read',
        code: 'invalid_if_revision',
      });
      return;
    }
    if (!UUID.test(workspaceId)) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    const client = (await getDataComposer()).getClient();
    // One statement: the fence and the change together.
    const { data, error } = await client
      .from('workspace_members')
      .update({ calendar_share: level, calendar_share_version: read.version + 1 })
      .eq('id', read.membershipId)
      .eq('workspace_id', workspaceId)
      .eq('user_id', inkUserId)
      .eq('calendar_share_version', read.version)
      .select(SHARE_COLUMNS);
    if (error) throw error;
    const row = (data ?? [])[0] as ShareRow | undefined;
    if (row) {
      logger.info('Calendar sharing changed', { workspaceId, level });
      res.json(shareOf(row));
      return;
    }
    // Nothing matched: not a member, or the revision has moved on.
    const { data: current, error: readError } = await client
      .from('workspace_members')
      .select(SHARE_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('user_id', inkUserId)
      .maybeSingle();
    if (readError) throw readError;
    if (!current) {
      res.status(404).json(NOT_A_MEMBER);
      return;
    }
    res.status(409).json({
      error: 'Calendar sharing changed since it was read',
      code: 'revision_changed',
      ...shareOf(current as ShareRow),
    });
  } catch (error) {
    logger.error('Calendar sharing: failed to change', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    res.status(500).json({ error: 'Failed to change calendar sharing' });
  }
});

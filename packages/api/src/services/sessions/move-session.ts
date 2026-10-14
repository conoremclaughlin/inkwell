/**
 * A session moves to the studio it works in (spec automated-turn-permissions
 * §3.6; task 7658c2e6).
 *
 * Conor, 2026-10-02: "It's actually a bug that in yolo / auto mode your
 * shadow clone couldn't cd into it and use it." A running Claude process
 * keeps the permissions of the checkout it was launched in, and a Bash deny
 * there applies to every command it runs, in any directory. So the fix is
 * not more rules for the running process: the session's NEXT turn launches
 * in the studio it is working in. A spawn's working directory follows the
 * session row's studio, and Claude Code resumes a session by id from any
 * directory. Measured model-free on 2.1.296: the resumed turn appends to the
 * same transcript file, in the original project folder, and Inkwell finds
 * transcripts by exact file name under every project folder.
 *
 * What a move checks:
 *   - only the caller's own session moves: the one its signed token (or,
 *     for an older token, its header) names, loaded and authorized against
 *     the caller. Never a session id taken from the arguments;
 *   - the target studio is the same user's and the same SB's, and not
 *     archived or cleaned;
 *   - a session whose current studio is a reviewer studio cannot move, so a
 *     move cannot shed reviewer restrictions. Moving INTO one only adds them.
 *
 * What it does: sets the session's studio and working directory and logs
 * the move. The running turn finishes as it is; nothing is spawned. For a
 * headless session it sends the session a session_resume, which queues
 * behind the running turn like any message, so its next turn runs in the
 * new studio. An attached terminal gets the one-line relaunch instead.
 */
import type { DataComposer } from '../../data/composer.js';
import { studioPermissionProfile } from '@inklabs/shared';
import {
  loadAuthorizedAmbientSession,
  type CallerIdentity,
} from '../../mcp/tools/caller-identity.js';
import { logger } from '../../utils/logger.js';

export type MoveSessionResult =
  | {
      ok: true;
      sessionId: string;
      fromStudioId: string | null;
      toStudioId: string;
      worktreePath: string;
      /** Headless: the next turn was queued to run in the new studio. */
      resumeQueued: boolean;
      /** Attached: what the person runs to continue there. */
      relaunch?: string;
    }
  | { ok: false; error: string };

export interface MoveSessionDeps {
  /** Sends the headless session its continuation; defaults to handleSendToInbox. */
  sendResume?: (args: Record<string, unknown>, composer: DataComposer) => Promise<unknown>;
}

export async function moveSessionToStudio(
  composer: DataComposer,
  input: { userId: string; caller: CallerIdentity; targetStudioId: string },
  deps: MoveSessionDeps = {}
): Promise<MoveSessionResult> {
  const ambient = await loadAuthorizedAmbientSession(composer, input.userId, input.caller);
  if (!ambient.session) {
    return {
      ok: false,
      error: `a move needs the session you are running in (${ambient.reason})`,
    };
  }
  const session = ambient.session;
  const studios = composer.repositories.studios;

  const target = await studios.findById(input.targetStudioId);
  if (!target || target.userId !== input.userId) {
    return { ok: false, error: `studio ${input.targetStudioId} is not one of yours` };
  }
  if (!session.sbId || target.sbId !== session.sbId) {
    return { ok: false, error: `studio ${input.targetStudioId} belongs to another SB` };
  }
  if (target.status === 'archived' || target.status === 'cleaned') {
    return { ok: false, error: `studio ${input.targetStudioId} is ${target.status}` };
  }

  const fromStudioId = session.studioId ?? null;
  if (fromStudioId === target.id) {
    return { ok: false, error: 'this session is already in that studio' };
  }
  if (fromStudioId) {
    const current = await studios.findById(fromStudioId);
    if (!current) {
      return {
        ok: false,
        error: `this session's studio ${fromStudioId} cannot be read, so whether it is a reviewer is unknown`,
      };
    }
    if (studioPermissionProfile(current) === 'reviewer') {
      return { ok: false, error: 'a session in a reviewer studio cannot move out of it' };
    }
  }

  // The write holds only while the session is still in the studio the checks
  // above read: a concurrent move (into a reviewer studio, say) must not be
  // overwritten by this stale one (Lumen, #853).
  const supabase = composer.getClient();
  const update = supabase
    .from('sessions')
    .update({ studio_id: target.id, working_dir: target.worktreePath })
    .eq('id', session.id)
    .eq('user_id', input.userId);
  const { data: moved, error } = await (
    fromStudioId ? update.eq('studio_id', fromStudioId) : update.is('studio_id', null)
  ).select('id, cli_attached');
  if (error) return { ok: false, error: `the session could not be moved: ${error.message}` };
  const row = (moved as Array<{ id: string; cli_attached: boolean | null }> | null)?.[0];
  if (!row) {
    return {
      ok: false,
      error:
        'the session could not be moved: it changed studio while this move was checked; read it and try again',
    };
  }

  await composer.repositories.memory
    .addSessionLog({
      sessionId: session.id,
      content: `Moved from studio ${fromStudioId ?? 'none'} to ${target.id} (${target.worktreePath}); the next turn runs there.`,
      salience: 'medium',
    })
    .catch((err: unknown) => {
      logger.warn('Session moved, but the move was not logged', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  logger.info('Session moved to studio', {
    sessionId: session.id,
    fromStudioId,
    toStudioId: target.id,
  });

  const base = {
    ok: true as const,
    sessionId: session.id,
    fromStudioId,
    toStudioId: target.id,
    worktreePath: target.worktreePath,
  };
  if (row.cli_attached) {
    const resumeId = session.backendSessionId ?? session.claudeSessionId;
    return {
      ...base,
      resumeQueued: false,
      relaunch: `cd ${target.worktreePath} && ink claude${resumeId ? ` --resume ${resumeId}` : ''}`,
    };
  }

  const send =
    deps.sendResume ??
    (async (args: Record<string, unknown>, c: DataComposer) =>
      (await import('../../mcp/tools/inbox-handlers.js')).handleSendToInbox(args, c));
  await send(
    {
      userId: input.userId,
      recipientSlug: session.sbSlug,
      recipientSessionId: session.id,
      senderSlug: 'system',
      messageType: 'session_resume',
      priority: 'high',
      content:
        `Continuing in studio ${target.slug ?? target.id} (${target.worktreePath}). ` +
        "This turn runs there, with that studio's permissions. Pick up where you left off.",
      trigger: true,
      triggerType: 'message',
      triggerSummary: `Continue in studio ${target.slug ?? target.id}`,
      metadata: { source: 'move_session', fromStudioId, toStudioId: target.id },
    },
    composer
  );
  return { ...base, resumeQueued: true };
}

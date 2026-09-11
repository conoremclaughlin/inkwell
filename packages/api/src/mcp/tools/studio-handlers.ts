/**
 * Studio Handlers
 *
 * MCP tools for managing git worktree studios. Enables agents to create
 * isolated worktrees for parallel work, track their lifecycle, and link
 * them to sessions for context continuity.
 */

import { z } from 'zod';
import path from 'path';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { access } from 'fs/promises';

const execFileAsync = promisify(execFile);
import type { DataComposer } from '../../data/composer';
import type { Json } from '../../data/supabase/types';
import { resolveUserOrThrow, userIdentifierBaseSchema } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import { bootstrapStudio } from '@inklabs/shared';
import { ensureStudioSettings } from '../../services/studio-settings';
import { resolveMainStudio } from '../../services/sessions/session-service';
import { resolveCaller, resolveImplicitSession } from './memory-handlers';
import { isSessionAuthorized, type CallerIdentity } from './caller-identity';
import { findOrCreateThread } from './inbox-handlers';
import { assignThreadParticipant } from '../../services/sessions/thread-assignment';
import type { Session } from '../../data/models/memory';
import {
  StudioLeaseService,
  EPHEMERAL_STUDIO_TTL_MS,
  captureWorktreeState,
  rescueSucceeded,
  worktreePresent,
} from '../../services/studio-lease.service';

// ============== Helpers ==============

/**
 * Resolve the main git worktree root from any path (worktree or main repo).
 * If the given path is a linked worktree, returns the main worktree root.
 * Falls back to the original path if git fails or isn't available.
 */
function resolveMainWorktree(dir: string): string {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // First entry in `git worktree list` is always the main worktree
    const match = output.match(/^worktree\s+(.+)$/m);
    return match ? match[1] : dir;
  } catch {
    return dir;
  }
}

// ============== Constants ==============

const WORK_TYPE_ABBREV: Record<string, string> = {
  feature: 'feat',
  bugfix: 'fix',
  refactor: 'refactor',
  chore: 'chore',
  experiment: 'exp',
  other: 'other',
};

// ============== Schemas ==============

const createStudioSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID creating the studio (e.g., "wren")'),
  repoRoot: z.string().describe('Absolute path to the main repository root'),
  slug: z
    .string()
    .describe('Short slug for the studio (used in branch name and worktree directory)'),
  workType: z
    .enum(['feature', 'bugfix', 'refactor', 'chore', 'experiment', 'other'])
    .optional()
    .default('feature')
    .describe('Type of work being done in this studio'),
  purpose: z.string().optional().describe('Human-readable description of what this studio is for'),
  baseBranch: z.string().optional().default('main').describe('Branch to base the new worktree on'),
  sessionId: z.string().guid().optional().describe('Session ID to link to this studio'),
  threadKey: z
    .string()
    .max(200)
    .optional()
    .describe(
      'The thread this studio is for (e.g. "pr:600"). Recorded on the studio, added as an exact route pattern so that thread routes here, and seeded into the creator session\'s lease so replies converge on the creator. Implies an ephemeral studio (72-hour expiry) unless durable is true.'
    ),
  durable: z
    .boolean()
    .optional()
    .describe(
      'Keep the studio past the ephemeral expiry. Defaults to true without a threadKey (a home studio) and false with one (thread-scoped ground).'
    ),
  roleTemplate: z
    .string()
    .optional()
    .describe('Role template name used when creating the studio (e.g., "reviewer", "builder")'),
  defaultProjectId: z
    .string()
    .guid()
    .optional()
    .describe('Default project ID for task groups created in this studio'),
  skipGitOperations: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, skip git worktree creation (useful when worktree already exists)'),
});

const listStudiosSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().optional().describe('Filter by agent ID'),
  status: z
    .enum(['active', 'idle', 'archived', 'cleaned', 'all'])
    .optional()
    .default('all')
    .describe('Filter by studio status'),
  includeAll: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, include all statuses including cleaned'),
});

const getStudioSchema = userIdentifierBaseSchema.extend({
  studioId: z.string().guid().optional().describe('Studio UUID'),
  branch: z.string().optional().describe('Branch name to look up'),
  path: z.string().optional().describe('Worktree path to look up'),
  agentId: z
    .string()
    .optional()
    .describe('Agent ID to disambiguate when multiple agents share the same branch or path'),
});

const updateStudioSchema = userIdentifierBaseSchema.extend({
  studioId: z.string().guid().describe('Studio UUID to update'),
  agentId: z.string().describe('Agent ID making the update'),
  status: z.enum(['active', 'idle', 'archived']).optional().describe('New studio status'),
  purpose: z.string().optional().describe('Updated purpose description'),
  roleTemplate: z.string().optional().describe('Role template name to set'),
  worktreePath: z.string().optional().describe('Updated worktree path (after rename/move)'),
  slug: z.string().optional().describe('Updated studio slug'),
  sessionId: z.string().guid().optional().describe('Session ID to link'),
  unlinkSession: z
    .boolean()
    .optional()
    .describe('If true, unlink the current session and set status to idle'),
  defaultProjectId: z
    .string()
    .guid()
    .nullable()
    .optional()
    .describe('Default project ID for task groups created in this studio. Set to null to clear.'),
  routePatterns: z
    .array(z.string().max(200))
    .optional()
    .describe(
      'ThreadKey glob patterns this studio handles for trigger routing. Examples: "pr:*", "spec:*", "branch:wren/feat/auth". Use "*" for catch-all (one per agent). Replaces existing patterns.'
    ),
  // NOTE: sandbox_bypass is intentionally NOT exposed via MCP tools — it's a
  // security-sensitive setting that should only be changed via admin API
  // endpoints or the web dashboard (future: /individuals/<id> settings page).
});

const closeStudioSchema = userIdentifierBaseSchema.extend({
  studioId: z.string().guid().describe('Studio UUID to close'),
  agentId: z.string().describe('Agent ID closing the studio'),
  removeWorktree: z
    .boolean()
    .optional()
    .default(true)
    .describe('If true, remove the git worktree from disk'),
  deleteBranch: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, delete the associated git branch'),
});

const adoptStudioSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID adopting the studio'),
  sessionId: z.string().guid().describe('Session ID to link to the studio'),
  studioId: z.string().guid().optional().describe('Studio UUID to adopt'),
  branch: z.string().optional().describe('Branch name to look up the studio'),
  worktreePath: z.string().optional().describe('Worktree path to look up the studio'),
  routePatterns: z
    .array(z.string().max(200))
    .optional()
    .describe('ThreadKey glob patterns this studio handles. Sets initial patterns on adoption.'),
  threadKey: z
    .string()
    .max(200)
    .optional()
    .describe(
      "The thread this studio is for. Recorded on the studio, added as an exact route pattern, and seeded into the adopting session's lease."
    ),
});

// ============== Helpers ==============

function successResponse(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, ...data }),
      },
    ],
  };
}

function errorResponse(error: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error }),
      },
    ],
    isError: true,
  };
}

// ============== Provenance ==============

type StudioProvenanceVia = 'create_studio' | 'adopt_studio';

interface LeaseSummary {
  acquired: boolean;
  threadKey: string;
  holder?: { sessionId: string; threadKey: string } | null;
}

/** The thread's home for this agent after binding: where its replies will go. */
interface HomeSummary {
  threadId: string;
  threadCreated: boolean;
  sessionId: string;
  boundVia: string;
  persisted: boolean;
}

/** What actually landed for a threadKey — never inferred from the request. */
interface RoutingOutcome {
  threadKey: string | null;
  patternInstalled: boolean;
  patternError?: string;
  home: HomeSummary | null;
  homeError?: string;
}

/**
 * An explicit sessionId is a target the caller named, not proof it is theirs.
 * Load it and authorize it the way every other session-targeting tool does:
 * the row must exist, belong to this user, and (for an agent-bound caller)
 * to the caller's own canonical identity and contact scope. Checked BEFORE
 * any side effect: a foreign session must never become a studio's creator,
 * lease holder, or log actor (Lumen, PR #605 P1). Repairing another
 * identity's session stays a user/admin operation.
 */
async function authorizeExplicitSession(
  dataComposer: DataComposer,
  userId: string,
  caller: CallerIdentity,
  sessionId: string,
  toolName: string
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  let session: Session | null;
  try {
    session = await dataComposer.repositories.memory.getSession(sessionId);
  } catch (err) {
    return {
      ok: false,
      error: `Could not load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!session) return { ok: false, error: `Session ${sessionId} not found` };
  if (!isSessionAuthorized(session, userId, caller)) {
    return {
      ok: false,
      error:
        `Not authorized to act as session ${sessionId}: it belongs to another identity. ` +
        `${toolName} confines agent-bound callers to their own sessions — acting for ` +
        `another agent's session is a user/admin operation.`,
    };
  }
  return { ok: true, session };
}

/**
 * The identity a studio operation acts as: the name the studio row, the lease,
 * the thread home and the log line all carry.
 */
interface ActingIdentity {
  agentId: string;
  sbId?: string;
}

const CREATOR_SESSION_RULE =
  "a studio's session must be the acting identity's own: it becomes the lease " +
  'holder and the thread home, both keyed by that identity';

/**
 * Who this call acts as. For an agent-bound caller that is the credential's
 * identity and nothing else: the typed `agentId` is a claim, and a claim that
 * disagrees with the credential is refused rather than reconciled. Authorizing
 * the session proved the caller may act on it, not that the typed name is who
 * acted — a Lumen request typed as wren, naming Lumen's own valid session,
 * would otherwise stamp wren's thread home with Lumen's session (Lumen,
 * PR #605 round 2). A user or admin token acts as the agent it names (a human
 * provisioning ground for an SB); there `sessionIdentityMismatch` is what
 * keeps the name honest.
 */
function resolveActingIdentity(
  caller: CallerIdentity,
  requestedAgentId: string,
  toolName: string
): { ok: true; actor: ActingIdentity } | { ok: false; error: string } {
  if (caller.agentBound && caller.agentId && caller.agentId !== requestedAgentId) {
    return {
      ok: false,
      error:
        `${toolName}: agentId ${requestedAgentId} is not the authenticated identity (${caller.agentId}). ` +
        'An agent creates or adopts a studio as itself; provisioning ground for another ' +
        'agent is a user/admin operation.',
    };
  }
  return { ok: true, actor: { agentId: caller.agentId ?? requestedAgentId, sbId: caller.sbId } };
}

/**
 * Why `session` cannot stand in for `actor`, or null when it can. Authorization
 * asks whether the caller may touch the row; this asks whether the row IS the
 * acting identity, because the participant stamp is keyed by the agent slug and
 * the lease names its holder. The canonical id decides whenever both sides
 * carry one; the slug is compared always, since it is the key the stamp is
 * written under.
 */
function sessionIdentityMismatch(session: Session, actor: ActingIdentity): string | null {
  if (actor.sbId && session.sbId && session.sbId !== actor.sbId) {
    return `session ${session.id} belongs to another identity (${session.sbId}), not ${actor.agentId}`;
  }
  if (session.agentId !== actor.agentId) {
    return `session ${session.id} belongs to agent ${session.agentId ?? '(none)'}, not ${actor.agentId}`;
  }
  return null;
}

// The thread tables are not in the generated Supabase types (see inbox-handlers).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const participantTable = (supabase: ReturnType<DataComposer['getClient']>) =>
  (supabase as unknown as { from: (t: string) => any }).from('inbox_thread_participants');

/**
 * Give the thread a home: this agent's participant row on the thread points at
 * the creator's session, written by the one sanctioned writer of that column.
 * The dispatcher then resolves the recipient session from that stamp before
 * routing ever looks at studios, so the first reply reaches the creator where
 * they already run — nothing is moved, and no fresh session is minted in the
 * new studio for a thread whose creator is alive (Lumen, PR #605 P2). The
 * thread row is created if it does not exist yet; that is what "this studio is
 * for pr:600" means before anyone has written to pr:600.
 */
async function bindThreadHome(
  dataComposer: DataComposer,
  opts: { userId: string; agentId: string; threadKey: string; sessionId: string; via: string }
): Promise<HomeSummary> {
  const supabase = dataComposer.getClient();
  const thread = await findOrCreateThread(supabase, {
    userId: opts.userId,
    threadKey: opts.threadKey,
    creatorAgentId: opts.agentId,
    title: null,
    participants: [opts.agentId],
  });
  if (!thread.isNew) {
    // An existing thread this agent is not yet on: join it first.
    const { data: row } = await participantTable(supabase)
      .select('agent_id')
      .eq('thread_id', thread.id)
      .eq('agent_id', opts.agentId)
      .maybeSingle();
    if (!row) {
      await participantTable(supabase).insert({ thread_id: thread.id, agent_id: opts.agentId });
    }
  }
  const assignment = await assignThreadParticipant(supabase, {
    threadId: thread.id,
    agentId: opts.agentId,
    candidateSessionId: opts.sessionId,
    explicitAnchor: true,
    source: opts.via,
  });
  return {
    threadId: thread.id,
    threadCreated: thread.isNew,
    sessionId: assignment.sessionId,
    boundVia: assignment.boundVia,
    persisted: assignment.stampPersisted,
  };
}

/**
 * Who made (or took over) this studio, and why — written to the activity log,
 * where the rest of what we do is already recorded (Conor, studio-model piece 1).
 * It rides the existing `state_change` type with a `studio_created` /
 * `studio_adopted` subtype: the column is a database enum, and a new value
 * would cost a migration for a label.
 *
 * Plus the two things a thread-scoped studio needs to actually receive its
 * thread: an exact route pattern, so routing picks this studio for that key,
 * and the creator's lease seeded with the key, so the occupancy gate passes
 * replies straight through to the creator's session. Owning ground never
 * moves the session: the lease names the session, the session stays where it
 * runs (Lumen, studio-model review).
 *
 * Everything here runs after the studio row exists and is best-effort: a
 * studio without a lease or a log line is still a studio, and the response
 * says exactly which parts landed.
 */
async function recordStudioProvenance(
  dataComposer: DataComposer,
  opts: {
    studio: {
      id: string;
      slug: string | null;
      worktreePath: string;
      branch: string;
      routePatterns?: string[] | null;
      ephemeral?: boolean;
      expiresAt?: string | null;
    };
    userId: string;
    agentId: string;
    sbId?: string;
    sessionId?: string;
    sessionReason?: string;
    threadKey?: string;
    purpose?: string;
    via: StudioProvenanceVia;
  }
): Promise<{ lease: LeaseSummary | null; routing: RoutingOutcome; logged: boolean }> {
  const { studio, userId, agentId, sessionId, threadKey, via } = opts;
  const routing: RoutingOutcome = {
    threadKey: threadKey ?? null,
    patternInstalled: false,
    home: null,
  };
  let lease: LeaseSummary | null = null;
  let logged = false;

  if (threadKey) {
    const existing = studio.routePatterns ?? [];
    const routePatterns = existing.includes(threadKey) ? existing : [...existing, threadKey];
    try {
      await dataComposer.repositories.studios.update(studio.id, { threadKey, routePatterns });
      routing.patternInstalled = true;
    } catch (err) {
      routing.patternError = err instanceof Error ? err.message : String(err);
      logger.warn('Studio provenance: could not record threadKey / route pattern', {
        studioId: studio.id,
        threadKey,
        error: routing.patternError,
      });
    }
    if (sessionId) {
      try {
        routing.home = await bindThreadHome(dataComposer, {
          userId,
          agentId,
          threadKey,
          sessionId,
          via,
        });
      } catch (err) {
        routing.homeError = err instanceof Error ? err.message : String(err);
        logger.warn('Studio provenance: could not bind the thread home', {
          studioId: studio.id,
          threadKey,
          sessionId,
          error: routing.homeError,
        });
      }
    }
  }

  if (sessionId) {
    // Thread-scoped ground is leased for its thread; a home studio is leased
    // to the session itself, the shape durable session-held studios already use.
    const leaseKey = threadKey ?? `session:${sessionId}`;
    try {
      const outcome = await new StudioLeaseService(dataComposer.getClient()).acquire({
        studioId: studio.id,
        sessionId,
        threadKey: leaseKey,
        agentId,
        userId,
        reason: via,
      });
      lease = outcome.acquired
        ? { acquired: true, threadKey: leaseKey }
        : {
            acquired: false,
            threadKey: leaseKey,
            holder: outcome.holder
              ? { sessionId: outcome.holder.sessionId, threadKey: outcome.holder.threadKey }
              : null,
          };
    } catch (err) {
      logger.warn('Studio provenance: lease acquisition failed', {
        studioId: studio.id,
        sessionId,
        threadKey: leaseKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const verb = via === 'create_studio' ? 'Created' : 'Adopted';
  const name = studio.slug || path.basename(studio.worktreePath);
  const content =
    `${verb} studio ${name}` +
    (threadKey ? ` for ${threadKey}` : '') +
    (opts.purpose ? `: ${opts.purpose}` : '');
  try {
    await dataComposer.repositories.activityStream.logActivity({
      userId,
      agentId,
      sbId: opts.sbId,
      sessionId,
      type: 'state_change',
      subtype: via === 'create_studio' ? 'studio_created' : 'studio_adopted',
      content,
      payload: {
        via,
        studioId: studio.id,
        slug: studio.slug ?? null,
        worktreePath: studio.worktreePath,
        branch: studio.branch,
        threadKey: threadKey ?? null,
        ephemeral: studio.ephemeral ?? null,
        expiresAt: studio.expiresAt ?? null,
        sessionId: sessionId ?? null,
        sessionReason: opts.sessionReason ?? null,
        lease: lease as unknown as Json,
        routing: routing as unknown as Json,
      },
    });
    logged = true;
  } catch (err) {
    logger.warn('Studio provenance: activity log write failed', {
      studioId: studio.id,
      via,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { lease, routing, logged };
}

/** Human-readable warnings for the parts of provenance that did not land. */
function provenanceWarnings(
  p: { lease: LeaseSummary | null; routing: RoutingOutcome; logged: boolean },
  sessionReason?: string
): string[] {
  const out: string[] = [];
  if (p.routing.threadKey && !p.routing.patternInstalled)
    out.push(
      `route pattern for ${p.routing.threadKey} was NOT installed: ${p.routing.patternError ?? 'unknown error'}`
    );
  if (p.routing.threadKey && p.routing.homeError)
    out.push(`thread home for ${p.routing.threadKey} was NOT bound: ${p.routing.homeError}`);
  if (p.routing.home && !p.routing.home.persisted)
    out.push(
      `thread home for ${p.routing.threadKey} did not persist (boundVia=${p.routing.home.boundVia})`
    );
  if (p.lease && !p.lease.acquired)
    out.push(
      `lease not acquired: held by session ${p.lease.holder?.sessionId ?? 'unknown'} (${p.lease.holder?.threadKey ?? 'unknown thread'})`
    );
  if (!p.lease && sessionReason)
    out.push(`no lease: creating session could not be identified (${sessionReason})`);
  if (!p.logged) out.push('activity log entry was NOT written');
  return out;
}

// ============== Handlers ==============

export async function handleCreateStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = createStudioSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    agentId,
    repoRoot,
    slug,
    workType = 'feature',
    purpose,
    baseBranch = 'main',
    sessionId,
    threadKey,
    durable,
    roleTemplate,
    defaultProjectId,
    skipGitOperations = false,
  } = parsed;

  // Who is creating this, from the signed request context — never from what
  // the caller typed: the typed agentId must be the authenticated identity.
  // An explicit sessionId still wins (a human linking a studio to a known
  // session); otherwise the session the caller runs in, if it can be
  // identified unambiguously. Never guessed (Lumen, #596). Either way the
  // session must be the acting identity's own before it becomes the creator.
  const caller = await resolveCaller(dataComposer, resolved.user.id, agentId);
  const acting = resolveActingIdentity(caller, agentId, 'create_studio');
  if (!acting.ok) return errorResponse(acting.error);
  const { actor } = acting;
  let creatorSessionId: string | undefined;
  let creatorSessionReason: string | undefined;
  if (sessionId) {
    const authorized = await authorizeExplicitSession(
      dataComposer,
      resolved.user.id,
      caller,
      sessionId,
      'create_studio'
    );
    if (!authorized.ok) return errorResponse(authorized.error);
    const mismatch = sessionIdentityMismatch(authorized.session, actor);
    if (mismatch) return errorResponse(`create_studio: ${mismatch}. ${CREATOR_SESSION_RULE}.`);
    creatorSessionId = sessionId;
  } else {
    const implicit = await resolveImplicitSession(
      dataComposer,
      resolved.user.id,
      caller,
      undefined
    );
    if (!implicit.session) {
      creatorSessionReason = implicit.reason;
    } else {
      // The ambient session is a hint about where the caller runs, not a
      // target they named: when it is not the acting identity's own, the
      // studio is still made — without a creator session, lease, or thread
      // home — and the response says why.
      const mismatch = sessionIdentityMismatch(implicit.session, actor);
      if (mismatch) creatorSessionReason = `identity-mismatch: ${mismatch}`;
      else creatorSessionId = implicit.session.id;
    }
  }
  // Thread-scoped ground is temporary by default; a home studio is not.
  const ephemeral = durable === undefined ? Boolean(threadKey) : !durable;
  const expiresAt = ephemeral ? new Date(Date.now() + EPHEMERAL_STUDIO_TTL_MS).toISOString() : null;

  if (defaultProjectId) {
    const project = await dataComposer.repositories.projects.findById(defaultProjectId);
    if (!project || project.user_id !== resolved.user.id) {
      return errorResponse('defaultProjectId not found or does not belong to this user');
    }
  }

  // Resolve to the main worktree root (handles case where repoRoot is a linked worktree)
  const mainRoot = resolveMainWorktree(repoRoot);

  // Derive branch name and worktree path (sibling of the main repo root)
  const abbrev = WORK_TYPE_ABBREV[workType] || 'other';
  const branch = `${actor.agentId}/${abbrev}/${slug}`;
  const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);

  // Perform git operations if not skipped
  if (!skipGitOperations) {
    try {
      logger.info('Creating git worktree', { branch, worktreePath, baseBranch, repoRoot });
      execSync(`git worktree add -b ${branch} ${worktreePath} ${baseBranch}`, {
        cwd: repoRoot,
        stdio: 'pipe',
      });

      // Install dependencies if package.json exists
      if (existsSync(path.join(worktreePath, 'package.json'))) {
        logger.info('Installing dependencies in worktree', { worktreePath });
        execSync('yarn install', {
          cwd: worktreePath,
          stdio: 'pipe',
        });
      }

      // Seed local config the same way `ink studio new` does. .mcp.json and
      // .env.local are gitignored, so `git worktree add` brings neither —
      // without this the studio has no MCP config at all: Claude sessions get
      // no tools, and Codex spawns against a partial [mcp_servers.inkwell]
      // and dies on "invalid transport". Copy from the resolved main root, not
      // the caller's repoRoot — a linked-worktree caller would otherwise seed
      // the new studio from its own (possibly customised or missing) config.
      // Best-effort; a studio that fails to bootstrap is still a usable
      // worktree.
      try {
        const result = bootstrapStudio(mainRoot, worktreePath);
        logger.info('Bootstrapped studio config', {
          worktreePath,
          copied: result.copied,
          codex: result.codex,
          gemini: result.gemini,
        });
      } catch (bootstrapError) {
        logger.warn('Studio config bootstrap failed', {
          worktreePath,
          error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
        });
      }
    } catch (gitError) {
      const errorMessage = gitError instanceof Error ? gitError.message : String(gitError);
      logger.error('Git worktree creation failed', { error: errorMessage, branch, worktreePath });
      return errorResponse(`Failed to create git worktree: ${errorMessage}`);
    }
  }

  // Generate .claude/settings.local.json with default permissions + hooks
  try {
    await ensureStudioSettings(worktreePath);
  } catch (settingsError) {
    // Non-fatal — studio is usable without auto-generated settings
    logger.warn('Failed to generate studio settings', {
      worktreePath,
      error: settingsError instanceof Error ? settingsError.message : String(settingsError),
    });
  }

  // Insert studio record into the database
  let studio;
  try {
    studio = await dataComposer.repositories.studios.create({
      userId: resolved.user.id,
      agentId: actor.agentId,
      sessionId: creatorSessionId,
      repoRoot: mainRoot,
      worktreePath,
      branch,
      baseBranch,
      purpose,
      workType,
      roleTemplate,
      defaultProjectId,
      threadKey: threadKey ?? null,
      ephemeral,
      expiresAt,
      metadata: { createdVia: 'create_studio', createdBySessionId: creatorSessionId ?? null },
    });
  } catch (dbError) {
    // If DB insert fails but git succeeded, attempt cleanup
    if (!skipGitOperations) {
      try {
        logger.warn('DB insert failed, cleaning up worktree', { worktreePath });
        execSync(`git worktree remove ${worktreePath}`, {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (cleanupError) {
        logger.error('Failed to clean up worktree after DB error', {
          worktreePath,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
    return errorResponse(`Failed to save studio record: ${errorMessage}`);
  }

  const provenance = await recordStudioProvenance(dataComposer, {
    studio,
    userId: resolved.user.id,
    agentId: actor.agentId,
    sbId: actor.sbId,
    sessionId: creatorSessionId,
    sessionReason: creatorSessionReason,
    threadKey,
    purpose,
    via: 'create_studio',
  });
  logger.info('Studio created', {
    studioId: studio.id,
    branch,
    worktreePath,
    agentId: actor.agentId,
    sessionId: creatorSessionId ?? null,
    threadKey: threadKey ?? null,
    ephemeral,
    lease: provenance.lease,
  });

  return successResponse({
    message: `Studio created at ${worktreePath}`,
    provenance: {
      sessionId: creatorSessionId ?? null,
      sessionReason: creatorSessionReason ?? null,
      logged: provenance.logged,
    },
    lease: provenance.lease,
    routing: provenance.routing,
    warnings: provenanceWarnings(provenance, creatorSessionReason),
    threadKey: threadKey ?? null,
    ephemeral,
    expiresAt,
    studio: {
      id: studio.id,
      studioId: studio.id,
      agentId: studio.agentId,
      branch: studio.branch,
      worktreeFolder: path.basename(studio.worktreePath),
      worktreePath: studio.worktreePath,
      repoRoot: studio.repoRoot,
      baseBranch: studio.baseBranch,
      purpose: studio.purpose,
      workType: studio.workType,
      roleTemplate: studio.roleTemplate,
      defaultProjectId: studio.defaultProjectId,
      status: studio.status,
      sessionId: studio.sessionId,
      createdAt: studio.createdAt,
    },
  });
}

export async function handleListStudios(args: unknown, dataComposer: DataComposer) {
  const parsed = listStudiosSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, status = 'all', includeAll = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  let studios;
  if (status !== 'all') {
    studios = await studiosRepo.listByUser(resolved.user.id, {
      status: status as 'active' | 'idle' | 'archived' | 'cleaned',
      agentId: agentId || undefined,
    });
  } else if (includeAll) {
    studios = await studiosRepo.listByUser(resolved.user.id, {
      agentId: agentId || undefined,
    });
  } else {
    // Default: get all but exclude 'cleaned'
    const all = await studiosRepo.listByUser(resolved.user.id, {
      agentId: agentId || undefined,
    });
    studios = all.filter((w) => w.status !== 'cleaned');
  }

  return successResponse({
    count: studios.length,
    studios: studios.map((w) => ({
      id: w.id,
      studioId: w.id,
      agentId: w.agentId,
      branch: w.branch,
      worktreePath: w.worktreePath,
      worktreeFolder: path.basename(w.worktreePath),
      path: w.worktreePath,
      purpose: w.purpose,
      status: w.status,
      workType: w.workType,
      roleTemplate: w.roleTemplate,
      defaultProjectId: w.defaultProjectId,
      hasLinkedSession: !!w.sessionId,
      // Occupancy: lease is the authoritative "is someone working here" —
      // status stays 'active' regardless of use and must not be read as such.
      lease: w.lease,
      ephemeral: w.ephemeral,
      parentStudioId: w.parentStudioId,
      expiresAt: w.expiresAt,
      createdAt: w.createdAt,
    })),
  });
}

export async function handleGetStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = getStudioSchema.parse(args);
  const { user } = await resolveUserOrThrow(parsed, dataComposer);

  const studiosRepo = dataComposer.repositories.studios;
  const scope = { userId: user.id, agentId: parsed.agentId };
  let studio = null;

  // Try identifiers in order: studioId, branch, path
  if (parsed.studioId) {
    studio = await studiosRepo.findById(parsed.studioId);
  } else if (parsed.branch) {
    studio = await studiosRepo.findByBranch(parsed.branch, scope);
  } else if (parsed.path) {
    studio = await studiosRepo.findByPath(parsed.path, scope);
  } else {
    return errorResponse('Must provide at least one of: studioId, branch, or path');
  }

  if (!studio) {
    return errorResponse('Studio not found');
  }

  return successResponse({
    studio: {
      id: studio.id,
      studioId: studio.id,
      agentId: studio.agentId,
      branch: studio.branch,
      worktreeFolder: path.basename(studio.worktreePath),
      worktreePath: studio.worktreePath,
      repoRoot: studio.repoRoot,
      baseBranch: studio.baseBranch,
      purpose: studio.purpose,
      workType: studio.workType,
      roleTemplate: studio.roleTemplate,
      defaultProjectId: studio.defaultProjectId,
      status: studio.status,
      sessionId: studio.sessionId,
      lease: studio.lease,
      ephemeral: studio.ephemeral,
      parentStudioId: studio.parentStudioId,
      expiresAt: studio.expiresAt,
      metadata: studio.metadata,
      createdAt: studio.createdAt,
      updatedAt: studio.updatedAt,
      archivedAt: studio.archivedAt,
      cleanedAt: studio.cleanedAt,
    },
  });
}

export async function handleUpdateStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = updateStudioSchema.parse(args);
  const resolved = await resolveUserOrThrow(parsed, dataComposer);

  const {
    studioId,
    agentId,
    status,
    purpose,
    roleTemplate,
    worktreePath,
    slug,
    sessionId,
    unlinkSession,
    defaultProjectId,
    routePatterns,
  } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify studio exists and belongs to this user
  const existing = await studiosRepo.findById(studioId);
  if (!existing) {
    return errorResponse(`Studio not found: ${studioId}`);
  }
  if (existing.userId !== resolved.user.id) {
    return errorResponse(`Studio not found: ${studioId}`);
  }

  if (typeof defaultProjectId === 'string') {
    const project = await dataComposer.repositories.projects.findById(defaultProjectId);
    if (!project || project.user_id !== resolved.user.id) {
      return errorResponse('defaultProjectId not found or does not belong to this user');
    }
  }

  let updated;

  if (unlinkSession) {
    updated = await studiosRepo.unlinkSession(studioId);
  } else if (sessionId) {
    updated = await studiosRepo.linkSession(studioId, sessionId);
  } else {
    const updateObj: Record<string, unknown> = {};
    if (status !== undefined) {
      updateObj.status = status;
    }
    if (purpose !== undefined) {
      updateObj.purpose = purpose;
    }
    if (roleTemplate !== undefined) {
      updateObj.roleTemplate = roleTemplate;
    }
    if (worktreePath !== undefined) {
      updateObj.worktreePath = worktreePath;
    }
    if (slug !== undefined) {
      updateObj.slug = slug;
    }
    if (defaultProjectId !== undefined) {
      updateObj.defaultProjectId = defaultProjectId;
    }
    if (routePatterns !== undefined) {
      updateObj.routePatterns = routePatterns;
    }
    updated = await studiosRepo.update(studioId, updateObj);
  }

  logger.info('Studio updated', { studioId, agentId, status: updated.status });

  return successResponse({
    message: 'Studio updated',
    studio: {
      id: updated.id,
      studioId: updated.id,
      agentId: updated.agentId,
      branch: updated.branch,
      worktreeFolder: path.basename(updated.worktreePath),
      worktreePath: updated.worktreePath,
      purpose: updated.purpose,
      roleTemplate: updated.roleTemplate,
      defaultProjectId: updated.defaultProjectId,
      status: updated.status,
      sessionId: updated.sessionId,
      updatedAt: updated.updatedAt,
    },
  });
}

export async function handleCloseStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = closeStudioSchema.parse(args);
  const { user: closingUser } = await resolveUserOrThrow(parsed, dataComposer);

  const { studioId, agentId, removeWorktree = true, deleteBranch = false } = parsed;
  const studiosRepo = dataComposer.repositories.studios;

  // Verify studio exists AND belongs to the closing user — repository lookups
  // are id-only, and close is destructive.
  const studio = await studiosRepo.findById(studioId);
  if (!studio || studio.userId !== closingUser.id) {
    return errorResponse(`Studio not found: ${studioId}`);
  }

  const cleanupResults: { worktreeRemoved: boolean; branchDeleted: boolean; errors: string[] } = {
    worktreeRemoved: false,
    branchDeleted: false,
    errors: [],
  };

  // Release any lease before touching the worktree — closing the studio is a
  // terminal act for its occupant, and release captures final branch/commit
  // state while the worktree still exists. A holder without a safe
  // terminal/stale proof refuses the whole close (lease marked
  // pendingRelease; re-run close after the holder's boundary frees it).
  const leaseService = new StudioLeaseService(dataComposer.getClient());
  const releaseOutcome = await leaseService
    .releaseByStudio(studioId, { userId: closingUser.id, reason: 'studio-closed' })
    .catch((leaseErr: unknown) => {
      logger.warn('[StudioLease] Release on close_studio failed', {
        studioId,
        error: leaseErr instanceof Error ? leaseErr.message : String(leaseErr),
      });
      return 'none' as const;
    });
  if (releaseOutcome === 'deferred') {
    return errorResponse(
      `Studio ${studioId} is in use by a live session. Its lease is marked for release at the holder's turn boundary — close the studio again once the session has finished.`
    );
  }
  // 'none' is NOT proof of vacancy — it also covers quarantine, a lost CAS,
  // and the caught release error. Never destroy on ambiguity.
  const residual = await leaseService.getLease(studioId, closingUser.id);
  if (residual?.lease) {
    // Reconciliation (idempotent): a quarantined claim over an ALREADY-ABSENT
    // worktree means destruction happened but the cleaned record didn't land
    // (a prior close's markCleaned failed, or the cwd vanished externally).
    // Nothing is left to protect — record cleaned and clear the exact claim.
    const worktreeGone = !(await access(studio.worktreePath)
      .then(() => true)
      .catch(() => false));
    if (residual.lease.quarantined && worktreeGone) {
      // ONE user+exact-claim-guarded CAS finalizes status/cleaned_at/lease
      // together — a claim replaced between observation and finalization
      // makes this fail, and failure is reported, never masked as success.
      const finalized = await leaseService.finalizeTeardown(
        studioId,
        closingUser.id,
        residual.lease
      );
      if (!finalized) {
        return errorResponse(
          `Studio ${studioId} reconciliation failed: the quarantine claim changed underneath (or the write failed). Nothing was recorded; retry close_studio.`
        );
      }
      logger.info('[StudioLease] close_studio reconciled an interrupted teardown', { studioId });
      return successResponse({
        message: 'Studio close reconciled: worktree already absent; cleaned state recorded',
        studioId,
        status: 'cleaned',
        cleanup: { worktreeRemoved: true, branchDeleted: false, errors: [] },
      });
    }
    return errorResponse(
      `Studio ${studioId} has a ${residual.lease.quarantined ? 'quarantined' : 'contended'} lease; refusing to close. Resolve the lease state first.`
    );
  }

  // Fence the destructive window: hold a unique teardown claim across
  // removal and mark-cleaned so no acquire can win the studio between the
  // release above and the removal below.
  const claim = await leaseService.claimForTeardown(studioId, closingUser.id, {
    reason: 'close_studio',
  });
  if (!claim) {
    return errorResponse(
      `Studio ${studioId} became occupied while closing; aborting. Retry once it is free.`
    );
  }

  // Claim lifecycle: cleared ONLY when the studio ends in a coherent state —
  // either nothing destructive happened (aborts below) or the cleaned state
  // is durably recorded. If the worktree was removed but persistence failed,
  // the claim STAYS so routing cannot acquire a studio whose cwd is gone.
  const abortKeepingStudioUsable = async (message: string) => {
    await leaseService.clearTeardownClaim(studioId, closingUser.id, claim).catch(() => undefined);
    return errorResponse(message);
  };

  // Remove the git worktree. Argument arrays (never shell interpolation —
  // stored paths/branches must not reach a shell) and async exec/fs — this
  // is a tool handler on the API server's single event loop.
  if (removeWorktree) {
    // Token revalidation immediately before destruction.
    if (!(await leaseService.verifyClaim(studioId, closingUser.id, claim))) {
      return errorResponse(`Studio ${studioId} teardown claim was lost; aborting close.`);
    }

    // Rescue BEFORE removal, fail closed (Lumen, PR #563 P1). Ephemeral
    // worktrees are detached: a CLEAN tree can still hold commits reachable
    // from no branch, and `git worktree remove` deletes them without
    // complaint — captureWorktreeState anchors those under ink-rescue/* and
    // stashes anything dirty. A failed rescue aborts with the studio intact.
    // An absent worktree has nothing to rescue: its capture error is not a
    // failed rescue, and the removal below already tolerates it.
    if (await worktreePresent(studio.worktreePath)) {
      const rescue = await captureWorktreeState(studio.worktreePath, {
        rescue: true,
        rescueLabel: `close:${studio.slug || studioId}`,
      });
      if (!rescueSucceeded(rescue)) {
        return abortKeepingStudioUsable(
          `Studio ${studioId} close aborted: work rescue failed (${rescue.error || 'unknown'}); worktree untouched.`
        );
      }
    }

    try {
      await execFileAsync('git', ['worktree', 'remove', '--', studio.worktreePath], {
        cwd: studio.repoRoot,
      });
      cleanupResults.worktreeRemoved = true;
    } catch (worktreeError) {
      const errorMessage =
        worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
      logger.warn('Failed to remove worktree (may already be gone)', {
        worktreePath: studio.worktreePath,
        error: errorMessage,
      });
      cleanupResults.errors.push(`Worktree removal: ${errorMessage}`);
    }
    // Only a confirmed-absent worktree may be recorded as cleaned.
    const stillPresent = await access(studio.worktreePath)
      .then(() => true)
      .catch(() => false);
    if (!cleanupResults.worktreeRemoved && stillPresent) {
      // Nothing was destroyed — the studio is still usable; free the claim.
      return abortKeepingStudioUsable(
        `Worktree removal failed and ${studio.worktreePath} still exists; studio NOT marked cleaned. Errors: ${cleanupResults.errors.join('; ')}`
      );
    }
    cleanupResults.worktreeRemoved = true;
  }

  // Delete the branch
  if (deleteBranch) {
    try {
      await execFileAsync('git', ['branch', '-d', '--', studio.branch], {
        cwd: studio.repoRoot,
      });
      cleanupResults.branchDeleted = true;
    } catch (branchError) {
      const errorMessage = branchError instanceof Error ? branchError.message : String(branchError);
      logger.warn('Failed to delete branch', {
        branch: studio.branch,
        error: errorMessage,
      });
      cleanupResults.errors.push(`Branch deletion: ${errorMessage}`);
    }
  }

  // Mark as cleaned in the database (ownership verified above). If this
  // write fails AFTER the worktree was destroyed, the claim must survive —
  // an active/vacant row pointing at a deleted cwd would be routable.
  // Re-running close_studio (or the sweep) reconciles via the
  // quarantine+absent-worktree path above. When nothing destructive
  // happened (removeWorktree: false), the claim is freed instead — the
  // studio is fully intact and must stay usable.
  //
  // Finalization is ONE user+exact-claim-guarded CAS setting status,
  // cleaned_at, and lease NULL together — no separate markCleaned + clear
  // steps a claim replacement could interleave with.
  const finalized = await leaseService.finalizeTeardown(studioId, closingUser.id, claim);
  if (!finalized) {
    if (!removeWorktree) {
      await leaseService.clearTeardownClaim(studioId, closingUser.id, claim).catch(() => undefined);
      return errorResponse(
        `Studio ${studioId} could not be marked cleaned (claim changed or write failed). Nothing was removed; the studio remains usable.`
      );
    }
    logger.error(
      '[StudioLease] close_studio destroyed the worktree but could not finalize cleaned; keeping teardown claim as quarantine',
      { studioId }
    );
    return errorResponse(
      `Studio ${studioId} worktree was removed but the cleaned state could not be recorded. The teardown claim is kept so nothing can route here; re-run close_studio to reconcile.`
    );
  }

  logger.info('Studio closed', {
    studioId,
    agentId,
    worktreeRemoved: cleanupResults.worktreeRemoved,
    branchDeleted: cleanupResults.branchDeleted,
  });

  return successResponse({
    message: 'Studio closed and marked as cleaned',
    studioId,
    status: 'cleaned',
    cleanup: cleanupResults,
  });
}

export async function handleAdoptStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = adoptStudioSchema.parse(args);
  const { user } = await resolveUserOrThrow(parsed, dataComposer);

  const { agentId, sessionId, routePatterns, threadKey } = parsed;
  const studiosRepo = dataComposer.repositories.studios;
  const caller = await resolveCaller(dataComposer, user.id, agentId);
  const acting = resolveActingIdentity(caller, agentId, 'adopt_studio');
  if (!acting.ok) return errorResponse(acting.error);
  const { actor } = acting;
  const scope = { userId: user.id, agentId: actor.agentId };
  const authorized = await authorizeExplicitSession(
    dataComposer,
    user.id,
    caller,
    sessionId,
    'adopt_studio'
  );
  if (!authorized.ok) return errorResponse(authorized.error);
  const mismatch = sessionIdentityMismatch(authorized.session, actor);
  if (mismatch) return errorResponse(`adopt_studio: ${mismatch}. ${CREATOR_SESSION_RULE}.`);

  // Find studio by ID, branch, or path
  let studio = null;
  if (parsed.studioId) {
    studio = await studiosRepo.findById(parsed.studioId);
  } else if (parsed.branch) {
    studio = await studiosRepo.findByBranch(parsed.branch, scope);
  } else if (parsed.worktreePath) {
    studio = await studiosRepo.findByPath(parsed.worktreePath, scope);
  } else {
    return errorResponse('Must provide at least one of: studioId, branch, or worktreePath');
  }

  if (!studio) {
    return errorResponse('Studio not found');
  }
  // Own ground only. findById is not scoped, so the row is checked here: a
  // studio of another user is not confirmed to exist, and a studio of another
  // agent is refused by name — adopting it would link, lease and log it under
  // an identity that never owned it (Lumen, PR #605 round 2). A studio with no
  // agent on record is unowned and stays adoptable.
  if (studio.userId !== user.id) {
    return errorResponse('Studio not found');
  }
  if (studio.agentId && studio.agentId !== actor.agentId) {
    return errorResponse(
      `Studio ${studio.id} belongs to ${studio.agentId}, not ${actor.agentId}. adopt_studio ` +
        'takes over your own ground; moving a studio between agents is a user/admin operation.'
    );
  }

  // Ensure settings exist in the worktree (may be first time adopting an old studio)
  try {
    await ensureStudioSettings(studio.worktreePath);
  } catch (settingsError) {
    logger.warn('Failed to ensure studio settings on adopt', {
      worktreePath: studio.worktreePath,
      error: settingsError instanceof Error ? settingsError.message : String(settingsError),
    });
  }

  // Link session and set to active
  let updated = await studiosRepo.linkSession(studio.id, sessionId);

  // Set route patterns if provided
  if (routePatterns !== undefined) {
    updated = await studiosRepo.update(studio.id, { routePatterns });
  }

  // Adoption takes the lease only when nobody else holds it: acquire refuses a
  // live foreign holder, and the response reports who that is.
  const provenance = await recordStudioProvenance(dataComposer, {
    studio: updated,
    userId: user.id,
    agentId: actor.agentId,
    sbId: actor.sbId,
    sessionId,
    threadKey,
    purpose: updated.purpose ?? undefined,
    via: 'adopt_studio',
  });
  logger.info('Studio adopted', {
    studioId: updated.id,
    agentId: actor.agentId,
    sessionId,
    threadKey: threadKey ?? null,
    lease: provenance.lease,
  });

  return successResponse({
    message: `Studio adopted by ${actor.agentId} and linked to session ${sessionId}`,
    provenance: { sessionId, logged: provenance.logged },
    lease: provenance.lease,
    routing: provenance.routing,
    warnings: provenanceWarnings(provenance),
    threadKey: threadKey ?? null,
    studio: {
      id: updated.id,
      studioId: updated.id,
      agentId: updated.agentId,
      branch: updated.branch,
      worktreeFolder: path.basename(updated.worktreePath),
      worktreePath: updated.worktreePath,
      purpose: updated.purpose,
      roleTemplate: updated.roleTemplate,
      defaultProjectId: updated.defaultProjectId,
      status: updated.status,
      sessionId: updated.sessionId,
      updatedAt: updated.updatedAt,
    },
  });
}

const registerStudioSchema = userIdentifierBaseSchema.extend({
  agentId: z.string().describe('Agent ID to own the studio'),
  repoRoot: z.string().describe('Absolute path to the repository root'),
});

export async function handleRegisterStudio(args: unknown, dataComposer: DataComposer) {
  const parsed = registerStudioSchema.parse(args);
  const { user } = await resolveUserOrThrow(parsed, dataComposer);

  // Check if studio already exists before auto-create
  const existingId = await resolveMainStudio(
    dataComposer.getClient(),
    user.id,
    parsed.repoRoot,
    parsed.agentId
  );

  const studioId =
    existingId ??
    (await resolveMainStudio(dataComposer.getClient(), user.id, parsed.repoRoot, parsed.agentId, {
      autoCreate: true,
    }));

  if (!studioId) {
    return errorResponse('Failed to register studio — could not create or find studio row');
  }

  const studio = await dataComposer.repositories.studios.findById(studioId);
  if (!studio) {
    return errorResponse('Studio was created but could not be retrieved');
  }

  return successResponse({
    studio: {
      id: studio.id,
      slug: studio.slug,
      repoRoot: studio.repoRoot,
      worktreePath: studio.worktreePath,
      branch: studio.branch,
      agentId: studio.agentId,
      status: studio.status,
    },
    created: !existingId,
  });
}

// ============== Tool Registration ==============

export const studioToolDefinitions = [
  {
    name: 'create_studio',
    description:
      'Create a new git worktree studio for isolated parallel work. Sets up the worktree, installs dependencies, and tracks it in the database.',
    schema: createStudioSchema,
    handler: handleCreateStudio,
  },
  {
    name: 'list_studios',
    description:
      'List studios for the current user. By default excludes cleaned studios unless includeAll is true. Can filter by agent and status.',
    schema: listStudiosSchema,
    handler: handleListStudios,
  },
  {
    name: 'get_studio',
    description: 'Get full details of a studio by its ID, branch name, or worktree path.',
    schema: getStudioSchema,
    handler: handleGetStudio,
  },
  {
    name: 'update_studio',
    description:
      'Update a studio status, purpose, or session linkage. Use unlinkSession to detach the current session and set status to idle.',
    schema: updateStudioSchema,
    handler: handleUpdateStudio,
  },
  {
    name: 'close_studio',
    description:
      'Close a studio by removing its git worktree, optionally deleting the branch, and marking it as cleaned in the database.',
    schema: closeStudioSchema,
    handler: handleCloseStudio,
  },
  {
    name: 'adopt_studio',
    description:
      'Adopt an existing studio by linking a new session to it and setting it to active. Useful when resuming work in a previously created worktree.',
    schema: adoptStudioSchema,
    handler: handleAdoptStudio,
  },
  {
    name: 'register_studio',
    description:
      'Register an existing repository as a studio. Creates a studio row for the root repo if one does not exist, or returns the existing one. Use this to make repos visible in the dashboard without starting a session.',
    schema: registerStudioSchema,
    handler: handleRegisterStudio,
  },
];

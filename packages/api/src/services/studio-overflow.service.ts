/**
 * Studio Overflow Service
 *
 * The overflow ladder (spec:trigger-studio-routing v13 §Overflow): when
 * routing resolves a studio that another thread holds, the flow is
 * "looks taken → spin up a quick temp studio" — never wait, never fall back
 * into the occupied worktree.
 *
 *   1. Reuse — an ephemeral studio already exists FOR THIS EXACT THREAD.
 *      A slug match alone is not identity: reuse requires ephemeral = true,
 *      the same parent, and the exact threadKey in metadata (slugs are
 *      normalized/truncated and not unique, so collisions with unrelated
 *      studios are possible). Colliding slugs disambiguate deterministically
 *      with a hash suffix, keeping retries idempotent.
 *   2. Create — a fresh git worktree from the parent studio's repo, using the
 *      same machinery as create_studio (worktree add + yarn install +
 *      bootstrap + settings). Docker backing slots in behind this same
 *      interface later.
 *
 * Ephemeral studios: `ephemeral = true`, `parent_studio_id` set, no route
 * patterns (never a routing target for new threads), inherit the parent's
 * default project, and expire. They close when their thread closes or when
 * expires_at passes with no live lease.
 *
 * Teardown is FENCED (PR #492 round 2): destruction only proceeds after
 * atomically claiming the studio with a quarantine-style lease that `acquire`
 * refuses — an acquire that wins first aborts the teardown, and a teardown
 * that wins first blocks acquires until the worktree is gone or the claim is
 * cleared. Destruction is additionally gated on a verified rescue, and
 * `cleaned` is recorded only after the worktree is confirmed gone from disk.
 * The branch is always kept — that is where the work lives.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { access } from 'fs/promises';
import { bootstrapStudio } from '@inklabs/shared';
import type { StudiosRepository, Studio } from '../data/repositories/studios.repository';
import { ensureStudioSettings } from './studio-settings';
import {
  StudioLeaseService,
  captureWorktreeState,
  rescueSucceeded,
  parseStudioLease,
  EPHEMERAL_STUDIO_TTL_MS,
  type StudioLease,
  type WorktreeFinalState,
} from './studio-lease.service';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

/** `pr:476` → `pr-476`; deterministic, filesystem- and branch-safe. */
export function threadSlug(threadKey: string): string {
  return (
    threadKey
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'thread'
  );
}

/**
 * Deterministic short hash of the FULL threadKey (djb2, base36). Used to
 * disambiguate slug collisions — normalization and truncation make distinct
 * threadKeys collide, and studio slugs are not unique.
 */
export function slugHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Spec naming: `<parent-slug>--<thread-slug>`, e.g. `lumen-review--pr-476`. */
export function overflowSlug(parentStudio: Studio, threadKey: string, variant?: string): string {
  const parentSlug = parentStudio.slug || path.basename(parentStudio.worktreePath) || 'studio';
  const tail = variant ? `${threadSlug(threadKey)}-h${variant}` : threadSlug(threadKey);
  return `${parentSlug}--${tail}`;
}

export class StudioOverflowService {
  constructor(
    private studios: StudiosRepository,
    private leases: StudioLeaseService
  ) {}

  /**
   * Is this row genuinely the overflow studio for (parent, threadKey)? A slug
   * collision with a long-lived studio or another thread's ephemeral must
   * never be "reused" — that would route this thread into unrelated work.
   */
  private matchesOverflow(existing: Studio, parentStudio: Studio, threadKey: string): boolean {
    if (!existing.ephemeral) return false;
    if (existing.parentStudioId !== parentStudio.id) return false;
    const metadata =
      existing.metadata &&
      typeof existing.metadata === 'object' &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    return metadata.threadKey === threadKey;
  }

  /**
   * Ladder steps 1–2: find or create the ephemeral studio for this threadKey.
   * Returns null only when worktree creation itself fails or every slug
   * candidate collides with an unrelated studio (both logged loudly); the
   * caller fails closed.
   */
  async ensureOverflowStudio(opts: {
    userId: string;
    agentId: string;
    parentStudio: Studio;
    threadKey: string;
  }): Promise<Studio | null> {
    const { userId, agentId, parentStudio, threadKey } = opts;

    const variants: Array<string | undefined> = [undefined, slugHash(threadKey)];
    for (const variant of variants) {
      const slug = overflowSlug(parentStudio, threadKey, variant);
      const branchTail = variant ? `${threadSlug(threadKey)}-h${variant}` : threadSlug(threadKey);

      const existing = await this.studios.findBySlug(userId, slug).catch(() => null);
      if (existing && !this.matchesOverflow(existing, parentStudio, threadKey)) {
        // Slug collision with an unrelated studio — never reuse or revive it.
        logger.warn('[StudioOverflow] Slug collides with an unrelated studio; disambiguating', {
          slug,
          threadKey,
          collidingStudioId: existing.id,
        });
        continue;
      }

      if (existing && (existing.status === 'active' || existing.status === 'idle')) {
        const pathExists = await access(existing.worktreePath)
          .then(() => true)
          .catch(() => false);
        if (pathExists) {
          logger.info('[StudioOverflow] Reusing ephemeral studio for thread', {
            threadKey,
            studioId: existing.id,
            slug,
          });
          return existing;
        }
        // Row survived but the worktree is gone — recreate in place.
        const revived = await this.createWorktree(parentStudio, slug, agentId, branchTail);
        if (!revived) return null;
        return this.studios.update(existing.id, {
          status: 'active',
          worktreePath: revived.worktreePath,
          cleanedAt: null,
          expiresAt: new Date(Date.now() + EPHEMERAL_STUDIO_TTL_MS).toISOString(),
        });
      }

      const created = await this.createWorktree(parentStudio, slug, agentId, branchTail);
      if (!created) return null;

      if (existing) {
        // A cleaned matching row already owns (worktree_path, agent_id) —
        // revive it rather than colliding with the unique index on insert.
        const revived = await this.studios.update(existing.id, {
          status: 'active',
          worktreePath: created.worktreePath,
          purpose: `Overflow studio for ${threadKey} (parent ${parentStudio.slug || parentStudio.id} was leased)`,
          cleanedAt: null,
          expiresAt: new Date(Date.now() + EPHEMERAL_STUDIO_TTL_MS).toISOString(),
        });
        await this.leases.logEvent(userId, revived.id, 'overflow', {
          threadKey,
          agentId,
          reason: `revived ephemeral studio; parent ${parentStudio.id} leased`,
        });
        return revived;
      }

      try {
        const studio = await this.studios.create({
          userId,
          agentId,
          repoRoot: parentStudio.repoRoot,
          worktreePath: created.worktreePath,
          branch: created.branch,
          baseBranch: parentStudio.baseBranch || 'main',
          purpose: `Overflow studio for ${threadKey} (parent ${parentStudio.slug || parentStudio.id} was leased)`,
          workType: 'other',
          defaultProjectId: parentStudio.defaultProjectId,
          ephemeral: true,
          parentStudioId: parentStudio.id,
          expiresAt: new Date(Date.now() + EPHEMERAL_STUDIO_TTL_MS).toISOString(),
          metadata: { overflow: true, threadKey },
        });
        await this.leases.logEvent(userId, studio.id, 'overflow', {
          threadKey,
          agentId,
          reason: `created ephemeral studio; parent ${parentStudio.id} leased`,
        });
        logger.info('[StudioOverflow] Created ephemeral studio', {
          threadKey,
          studioId: studio.id,
          slug,
          worktreePath: created.worktreePath,
        });
        return studio;
      } catch (err) {
        logger.error('[StudioOverflow] Studio row insert failed; removing worktree', {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
        await execFileAsync('git', ['worktree', 'remove', '--force', created.worktreePath], {
          cwd: parentStudio.repoRoot,
        }).catch(() => undefined);
        return null;
      }
    }

    logger.error('[StudioOverflow] Every slug candidate collides with unrelated studios', {
      threadKey,
      parentStudioId: parentStudio.id,
    });
    return null;
  }

  /**
   * D1: the per-(project, agent) PARENT studio, `<project>--<sbSlug>`.
   *
   * Created on first work for a repo, by the caller-repo routing tier
   * (spec §Tier 7, Phase 3b). Distinct from an overflow child in three ways
   * that matter:
   *
   *   - it is NOT ephemeral and carries no `expires_at` — it is the agent's
   *     durable home for this project, and a working studio in its own right
   *     rather than a pure anchor. It takes work itself whenever it is free;
   *     ephemeral children hang off it only when it is busy.
   *   - it has no `parent_studio_id` — it IS the parent.
   *   - its branch is per-agent (`<agent>/studio/<agent>`), not `eph/`.
   *
   * Route patterns are deliberately not set: patterns are an operator
   * convention, and inventing one here would silently start capturing threads
   * the operator never assigned.
   *
   * Returns null when provisioning fails or the slug is already taken by an
   * unrelated studio; the caller then refuses rather than guessing.
   */
  async ensureParentStudio(opts: {
    userId: string;
    agentId: string;
    repoRoot: string;
    /** Canonical identity UUID — authoritative over the display slug. */
    sbId?: string | null;
  }): Promise<Studio | null> {
    const { userId, agentId, repoRoot, sbId } = opts;
    const slug = `${path.basename(repoRoot)}--${agentId}`;

    const existing = await this.studios.findBySlug(userId, slug).catch(() => null);
    if (existing) {
      // Reuse only a genuine match. A slug collision with an unrelated studio
      // must never be adopted — same reasoning as overflow reuse, and the
      // consequence here is worse because this row is durable.
      // Reuse only a studio a runner can ACTUALLY use (Lumen, PR #514 round 1).
      //
      // The earlier predicate accepted any non-ephemeral match, including an
      // archived or cleaned row, or one whose worktree is gone from disk.
      // Handing one back creates a session that acquire() then refuses
      // (spec §The five invariants #5: a cleaned studio is never re-leased,
      // a configured-but-absent worktree is retired) — and the caller diverts
      // to overflow or the default cwd instead of holding, which is the
      // silent-wrong-place outcome this phase removes.
      const reusable =
        !existing.ephemeral &&
        existing.userId === userId &&
        existing.repoRoot === repoRoot &&
        (sbId ? existing.sbId === sbId : existing.agentId === agentId) &&
        (existing.status === 'active' || existing.status === 'idle');

      if (reusable) {
        const present = await access(existing.worktreePath)
          .then(() => true)
          .catch(() => false);
        if (present) return existing;
        logger.warn('[StudioOverflow] Parent studio worktree is gone; refusing reuse', {
          slug,
          studioId: existing.id,
          worktreePath: existing.worktreePath,
        });
        return null;
      }
      logger.warn('[StudioOverflow] Parent slug collides with an unrelated studio; refusing', {
        slug,
        repoRoot,
        agentId,
        collidingStudioId: existing.id,
      });
      return null;
    }

    // Seed from a studio that already knows this repo, so worktree creation
    // runs against a real checkout with the right base branch.
    const seed = await this.studios.findByRepoRoot(userId, repoRoot).catch(() => null);
    const parentLike = {
      repoRoot,
      baseBranch: seed?.baseBranch || 'main',
    } as Studio;

    const created = await this.createWorktree(parentLike, slug, agentId, agentId, {
      branch: `${agentId}/studio/${agentId}`,
    });
    if (!created) return null;

    try {
      const studio = await this.studios.create({
        userId,
        agentId,
        sbId: sbId ?? undefined,
        repoRoot,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseBranch: parentLike.baseBranch,
        purpose: `Home studio for ${agentId} on ${path.basename(repoRoot)} (auto-created)`,
        ephemeral: false,
        defaultProjectId: seed?.defaultProjectId ?? null,
        metadata: { autoCreated: true, createdBy: 'caller-repo-routing' },
      });
      logger.info('[StudioOverflow] Created parent studio', {
        studioId: studio.id,
        slug: studio.slug,
        repoRoot,
        agentId,
        worktreePath: created.worktreePath,
      });
      return studio;
    } catch (err) {
      logger.error('[StudioOverflow] Parent studio row insert failed; removing worktree', {
        slug,
        worktreePath: created.worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      await execFileAsync('git', ['worktree', 'remove', '--force', created.worktreePath], {
        cwd: repoRoot,
      }).catch(() => undefined);
      return null;
    }
  }

  private async createWorktree(
    parentStudio: Studio,
    slug: string,
    agentId: string,
    branchTail: string,
    opts?: { branch?: string }
  ): Promise<{ worktreePath: string; branch: string } | null> {
    const mainRoot = parentStudio.repoRoot;
    const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);
    // Parent studios pass an explicit branch: `eph/` names a temporary
    // worktree, and a durable home studio is not one.
    const branch = opts?.branch || `${agentId}/eph/${branchTail}`;
    const baseBranch = parentStudio.baseBranch || 'main';

    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], {
        cwd: mainRoot,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Branch may survive a previous teardown (branches are kept on close —
      // they hold the work). Retry attached to the existing branch.
      if (message.includes('already exists')) {
        try {
          await execFileAsync('git', ['worktree', 'add', worktreePath, branch], {
            cwd: mainRoot,
          });
        } catch (retryErr) {
          logger.error('[StudioOverflow] Worktree creation failed (existing-branch retry)', {
            branch,
            worktreePath,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          return null;
        }
      } else {
        logger.error('[StudioOverflow] Worktree creation failed', {
          branch,
          worktreePath,
          error: message,
        });
        return null;
      }
    }

    const pkgJson = await access(path.join(worktreePath, 'package.json'))
      .then(() => true)
      .catch(() => false);
    if (pkgJson) {
      await execFileAsync('yarn', ['install'], { cwd: worktreePath, timeout: 120_000 }).catch(
        (err) => {
          logger.warn('[StudioOverflow] yarn install failed (non-fatal)', {
            worktreePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      );
    }

    try {
      bootstrapStudio(mainRoot, worktreePath);
    } catch (err) {
      logger.warn('[StudioOverflow] bootstrapStudio failed (non-fatal)', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await ensureStudioSettings(worktreePath).catch(() => undefined);

    return { worktreePath, branch };
  }

  /**
   * Close an ephemeral studio when its work unit completes: claim the studio
   * against concurrent acquires, rescue anything dirty (safe ref), remove the
   * worktree, keep the branch, mark cleaned.
   *
   * SAFETY (PR #492 rounds 1–2):
   *   - Destruction only proceeds after `claimForTeardown` wins an atomic
   *     lease claim that `acquire` refuses — no acquire can slip in between
   *     the check and the removal, and a holder that won first aborts us.
   *   - Destruction is gated on a verified rescue; `--force` is only ever
   *     reached with the tree verified clean or stashed.
   *   - `cleaned` is recorded only after the worktree is confirmed gone.
   *   - On abort the claim REMAINS as quarantine, blocking acquirers until a
   *     later retry (sweep) rescues or a human intervenes.
   */
  async teardownEphemeralStudio(
    studio: Studio,
    opts: { reason: string; expectedThreadKey?: string }
  ): Promise<void> {
    if (!studio.ephemeral) {
      logger.warn('[StudioOverflow] Refusing to tear down non-ephemeral studio', {
        studioId: studio.id,
      });
      return;
    }

    // Fence: atomically claim the studio. A live holder, a foreign thread, or
    // another worker's active claim aborts.
    const claim = await this.leases.claimForTeardown(studio.id, studio.userId, {
      expectedThreadKey: opts.expectedThreadKey,
      reason: `teardown-claim (${opts.reason})`,
    });
    if (!claim) {
      logger.info('[StudioOverflow] Teardown skipped — studio is held', {
        studioId: studio.id,
        reason: opts.reason,
      });
      // Thread-close context: the holder's boundary will release the lease
      // soon (pendingRelease). Pull expires_at to now so the 5-minute sweep
      // retries this teardown promptly instead of waiting out the 72h TTL.
      if (opts.expectedThreadKey) {
        await this.studios
          .update(studio.id, { expiresAt: new Date().toISOString() })
          .catch(() => undefined);
      }
      return;
    }

    const worktreeExists = await access(studio.worktreePath)
      .then(() => true)
      .catch(() => false);

    let finalState: WorktreeFinalState | undefined;
    if (worktreeExists) {
      finalState = await captureWorktreeState(studio.worktreePath, {
        rescue: true,
        rescueLabel: `teardown:${studio.slug || studio.id}`,
      });

      if (!rescueSucceeded(finalState)) {
        // Abort with the claim left in place: the quarantine blocks acquires
        // until a later rescue succeeds. The worktree is untouched.
        logger.error(
          '[StudioOverflow] Teardown aborted — rescue failed; worktree quarantined in place',
          {
            studioId: studio.id,
            worktreePath: studio.worktreePath,
            reason: opts.reason,
            finalState,
          }
        );
        await this.leases.logEvent(studio.userId, studio.id, 'conflict', {
          agentId: studio.agentId ?? undefined,
          reason: `teardown-aborted-rescue-failed (${opts.reason})`,
          detail: { finalState: JSON.parse(JSON.stringify(finalState)) },
        });
        return;
      }

      // Token revalidation immediately before destruction: if our claim aged
      // out and another worker took over, the removal is theirs, not ours.
      if (!(await this.leases.verifyClaim(studio.id, studio.userId, claim))) {
        logger.warn('[StudioOverflow] Teardown aborted — claim no longer ours', {
          studioId: studio.id,
          worktreePath: studio.worktreePath,
        });
        return;
      }

      await execFileAsync('git', ['worktree', 'remove', studio.worktreePath], {
        cwd: studio.repoRoot,
      }).catch(async (err) => {
        logger.warn('[StudioOverflow] worktree remove failed; retrying with --force', {
          worktreePath: studio.worktreePath,
          error: err instanceof Error ? err.message : String(err),
        });
        // Safe only because the rescue above verified the tree is clean or
        // its dirty state is stashed with a recorded commit SHA.
        await execFileAsync('git', ['worktree', 'remove', '--force', studio.worktreePath], {
          cwd: studio.repoRoot,
        }).catch(() => undefined);
      });

      const stillPresent = await access(studio.worktreePath)
        .then(() => true)
        .catch(() => false);
      if (stillPresent) {
        // Claim stays: a half-removed worktree must not be acquirable.
        logger.error(
          '[StudioOverflow] Worktree still present after removal attempts; NOT marking cleaned',
          { studioId: studio.id, worktreePath: studio.worktreePath }
        );
        await this.leases.logEvent(studio.userId, studio.id, 'conflict', {
          agentId: studio.agentId ?? undefined,
          reason: `teardown-remove-failed (${opts.reason})`,
          detail: { finalState: JSON.parse(JSON.stringify(finalState)) },
        });
        return;
      }
    } else {
      // Worktree already gone (manual cleanup) — prune the stale registration
      // and record the row as cleaned.
      await execFileAsync('git', ['worktree', 'prune'], { cwd: studio.repoRoot }).catch(
        () => undefined
      );
    }

    // ONE user+exact-claim-guarded CAS records cleaned + clears the claim
    // together (round 7) — a claim replaced mid-teardown fails here and the
    // sweep reconciles instead of us reporting a phantom success.
    const finalized = await this.leases
      .finalizeTeardown(studio.id, studio.userId, claim)
      .catch(() => false);
    if (!finalized) {
      logger.error(
        '[StudioOverflow] Teardown finalization failed — claim changed; sweep will reconcile',
        {
          studioId: studio.id,
        }
      );
      return;
    }
    await this.leases.logEvent(studio.userId, studio.id, 'released', {
      agentId: studio.agentId ?? undefined,
      reason: opts.reason,
      detail: {
        teardown: true,
        finalState: finalState ? JSON.parse(JSON.stringify(finalState)) : null,
      },
    });
    logger.info('[StudioOverflow] Ephemeral studio cleaned', {
      studioId: studio.id,
      worktreePath: studio.worktreePath,
      reason: opts.reason,
      finalState,
    });
  }

  /**
   * Sweep companion: close ephemeral studios whose expires_at has passed and
   * whose lease is gone (or is a stale quarantine/teardown claim to retry).
   * Runs on the heartbeat cron alongside the lease sweep. Live leases are
   * skipped here and re-checked atomically inside claimForTeardown.
   */
  async sweepExpiredEphemeralStudios(): Promise<number> {
    const candidates = await this.studios
      .listExpiredEphemeral(new Date().toISOString())
      .catch(() => [] as Studio[]);
    let closed = 0;
    for (const studio of candidates) {
      const lease: StudioLease | null = parseStudioLease(studio.lease);
      if (lease && !lease.quarantined) continue; // genuinely held — not expirable here
      await this.teardownEphemeralStudio(studio, { reason: 'expired' });
      closed += 1;
    }
    return closed;
  }

  /**
   * Close every ephemeral studio that served a thread. Wired into
   * close_thread — the work unit completing releases the temp studio. Each
   * teardown fences via claimForTeardown with the closing thread's key, so a
   * studio a different thread has since acquired is skipped, not destroyed.
   */
  async teardownEphemeralStudiosForThread(
    userId: string,
    threadKey: string,
    opts: { reason: string }
  ): Promise<number> {
    const studios = await this.studios
      .listEphemeralByThread(userId, threadKey)
      .catch(() => [] as Studio[]);
    let closed = 0;
    for (const studio of studios) {
      await this.teardownEphemeralStudio(studio, {
        reason: opts.reason,
        expectedThreadKey: threadKey,
      });
      closed += 1;
    }
    return closed;
  }
}

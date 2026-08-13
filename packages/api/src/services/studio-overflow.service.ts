/**
 * Studio Overflow Service
 *
 * The overflow ladder (spec:trigger-studio-routing v11 §Overflow): when
 * routing resolves a studio that another thread holds, the flow is
 * "looks taken → spin up a quick temp studio" — never wait, never fall back
 * into the occupied worktree.
 *
 *   1. Reuse — an ephemeral studio already exists for this threadKey.
 *      Deterministic naming makes retries idempotent instead of fanning out
 *      orphan worktrees.
 *   2. Create — a fresh git worktree from the parent studio's repo, using the
 *      same machinery as create_studio (worktree add + yarn install +
 *      bootstrap + settings). Docker backing slots in behind this same
 *      interface later.
 *
 * Ephemeral studios: `ephemeral = true`, `parent_studio_id` set, no route
 * patterns (never a routing target for new threads), inherit the parent's
 * default project, and expire. They close when their thread closes or when
 * expires_at passes with no live lease. Close = rescue anything dirty, remove
 * the worktree, keep the branch (that is where the work lives), mark cleaned.
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
  EPHEMERAL_STUDIO_TTL_MS,
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

/** Spec naming: `<parent-slug>--<thread-slug>`, e.g. `lumen-review--pr-476`. */
export function overflowSlug(parentStudio: Studio, threadKey: string): string {
  const parentSlug = parentStudio.slug || path.basename(parentStudio.worktreePath) || 'studio';
  return `${parentSlug}--${threadSlug(threadKey)}`;
}

export class StudioOverflowService {
  constructor(
    private studios: StudiosRepository,
    private leases: StudioLeaseService
  ) {}

  /**
   * Ladder steps 1–2: find or create the ephemeral studio for this threadKey.
   * Returns null only when worktree creation itself fails (logged loudly);
   * the caller decides how to degrade.
   */
  async ensureOverflowStudio(opts: {
    userId: string;
    agentId: string;
    parentStudio: Studio;
    threadKey: string;
  }): Promise<Studio | null> {
    const { userId, agentId, parentStudio, threadKey } = opts;
    const slug = overflowSlug(parentStudio, threadKey);

    // 1) Reuse — retries and re-triggers converge on the same studio.
    const existing = await this.studios.findBySlug(userId, slug).catch(() => null);
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
      const revived = await this.createWorktree(parentStudio, slug, agentId, threadKey);
      if (!revived) return null;
      return this.studios.update(existing.id, {
        status: 'active',
        worktreePath: revived.worktreePath,
        cleanedAt: null,
        expiresAt: new Date(Date.now() + EPHEMERAL_STUDIO_TTL_MS).toISOString(),
      });
    }

    // 2) Create.
    const created = await this.createWorktree(parentStudio, slug, agentId, threadKey);
    if (!created) return null;

    if (existing) {
      // A cleaned row already owns (worktree_path, agent_id) — revive it
      // rather than colliding with the unique index on insert.
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

  private async createWorktree(
    parentStudio: Studio,
    slug: string,
    agentId: string,
    threadKey: string
  ): Promise<{ worktreePath: string; branch: string } | null> {
    const mainRoot = parentStudio.repoRoot;
    const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}--${slug}`);
    const branch = `${agentId}/eph/${threadSlug(threadKey)}`;
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
   * Close an ephemeral studio when its work unit completes: rescue anything
   * dirty (safe ref), remove the worktree, keep the branch, mark cleaned.
   *
   * SAFETY (PR #492 review): destruction is gated on a verified rescue. If
   * the rescue fails — a conflicted rebase can make `git stash` fail — the
   * teardown ABORTS with the worktree left in place; --force is only ever
   * reached with the tree verified clean or stashed. `cleaned` is recorded
   * only after the worktree is confirmed gone from disk.
   */
  async teardownEphemeralStudio(studio: Studio, opts: { reason: string }): Promise<void> {
    if (!studio.ephemeral) {
      logger.warn('[StudioOverflow] Refusing to tear down non-ephemeral studio', {
        studioId: studio.id,
      });
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
        logger.error(
          '[StudioOverflow] Teardown aborted — rescue failed; leaving worktree in place',
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

    await this.studios.markCleaned(studio.id).catch(() => undefined);
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
   * whose lease is gone. Runs on the heartbeat cron alongside the lease sweep.
   */
  async sweepExpiredEphemeralStudios(): Promise<number> {
    const candidates = await this.studios
      .listExpiredEphemeral(new Date().toISOString())
      .catch(() => [] as Studio[]);
    let closed = 0;
    for (const studio of candidates) {
      if (studio.lease) continue;
      await this.teardownEphemeralStudio(studio, { reason: 'expired' });
      closed += 1;
    }
    return closed;
  }

  /**
   * Close every ephemeral studio that served a thread. Wired into
   * close_thread — the work unit completing releases the temp studio.
   */
  async teardownEphemeralStudiosForThread(
    userId: string,
    threadKey: string,
    opts: { reason: string }
  ): Promise<number> {
    const studios = await this.studios
      .listEphemeralByThread(userId, threadKey)
      .catch(() => [] as Studio[]);
    for (const studio of studios) {
      await this.teardownEphemeralStudio(studio, opts);
    }
    return studios.length;
  }
}

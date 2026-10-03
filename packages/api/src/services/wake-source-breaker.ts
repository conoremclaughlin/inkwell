/**
 * No-progress breaker for automatic wake sources
 * (ink://specs/session-lifecycle-model §5, task T1).
 *
 * A wake source wakes an SB to move one work item forward: a strategy
 * watchdog for its group, graph dispatch for a ready node, and (task
 * c52fccfd) a reminder whose purpose is work. PR #349 was a watchdog waking a
 * session every ten minutes for a task that never moved; `ended_at` was made
 * a routing fence to hide it. The fence hid a work-state bug, so the stop
 * belongs on work state, and this is it.
 *
 * The rules, from the spec:
 * - Counted per durable source and work item (and revision), never per
 *   session: a home session serves many sources.
 * - Only completed, admitted attempts count. The trigger handler records an
 *   attempt after its turn returns successfully. A held or refused delivery,
 *   an inline delivery to an attached terminal (no completion is observable),
 *   a failed turn, and an attempt queued behind one already counted all leave
 *   the count alone.
 * - Progress is a change to the work item's state fingerprint: task status,
 *   outcome and gate state, or a group's status, cursor and task statuses. A
 *   thread message, a dispatch stamp or an activity row is not progress, or
 *   the wake and its "nothing to do" reply would reset the count forever.
 * - At the limit (3 by default) the row trips. The source stops waking for
 *   that item until its fingerprint changes or the source is resumed, and one
 *   notice goes to the owner (a comment on the work item) and to Myra.
 *
 * Observation reminders and heartbeats never come here: they keep maxRuns.
 * Human messages and explicit replies never come here either; only a source's
 * own fire decision reads the breaker, and delivery never does.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { DataComposer } from '../data/composer';
import { resolveSbId, resolveSbSlug } from '../auth/resolve-identity';
import { SYSTEM_PRINCIPAL } from './principals';
import { logger } from '../utils/logger';

export type WakeSource = 'strategy_watchdog' | 'graph_dispatch' | 'reminder_work';
export type WakeWorkKind = 'task_group' | 'task' | 'graph_node';

export const WAKE_SOURCES: readonly WakeSource[] = [
  'strategy_watchdog',
  'graph_dispatch',
  'reminder_work',
];
export const WAKE_WORK_KINDS: readonly WakeWorkKind[] = ['task_group', 'task', 'graph_node'];

/** Consecutive completed no-progress attempts before a source trips. */
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

/** The SB that triages trip notices, per the spec. */
export const DEFAULT_BREAKER_NOTIFY_SLUG = 'myra';

export interface WakeSourceKey {
  userId: string;
  source: WakeSource;
  workKind: WakeWorkKind;
  workId: string;
  /** Empty when the item has no revision. */
  revision: string;
}

/** What a source knows about one wake when it fires. */
export interface WakeSourceTagFields {
  source: WakeSource;
  workKind: WakeWorkKind;
  workId: string;
  revision: string;
  /** The work item's fingerprint when the wake was dispatched. */
  fingerprint: string;
  dispatchedAt: string;
  taskGroupId: string | null;
  ownerSbId: string | null;
}

/**
 * Carried on the wake message's metadata as `wakeSource`, from the source's
 * fire decision to the trigger handler that records the attempt.
 *
 * Only a tag this server issued counts. The signature is an HMAC over every
 * field under a key generated when the process starts, so a tag a caller
 * writes into metadata (send_to_inbox, trigger_agent or any future ingress)
 * fails verification, and a field changed after issue does too. Both public
 * ingresses also drop the key outright. A tag issued before a restart no
 * longer verifies, so its completion goes uncounted, which only delays a trip.
 * A replayed genuine tag cannot add a count: it is a duplicate of the attempt
 * it copies (decideCompletedAttempt).
 */
export interface WakeSourceTag extends WakeSourceTagFields {
  signature: string;
}

const TAG_KEY = randomBytes(32);

function tagSignature(fields: WakeSourceTagFields): string {
  return createHmac('sha256', TAG_KEY)
    .update(
      JSON.stringify([
        fields.source,
        fields.workKind,
        fields.workId,
        fields.revision,
        fields.fingerprint,
        fields.dispatchedAt,
        fields.taskGroupId,
        fields.ownerSbId,
      ])
    )
    .digest('hex');
}

/** Sign a wake's tag. Sources call this when they fire, never callers. */
export function issueWakeSourceTag(fields: WakeSourceTagFields): WakeSourceTag {
  return { ...fields, signature: tagSignature(fields) };
}

function signatureMatches(fields: WakeSourceTagFields, signature: string): boolean {
  const expected = Buffer.from(tagSignature(fields), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface BreakerRow {
  id: string;
  user_id: string;
  source: WakeSource;
  work_kind: WakeWorkKind;
  work_id: string;
  revision: string;
  task_group_id: string | null;
  owner_sb_id: string | null;
  no_progress_count: number;
  last_counted_at: string | null;
  last_fingerprint: string | null;
  tripped_at: string | null;
  tripped_fingerprint: string | null;
  last_tripped_at: string | null;
  trip_count: number;
  last_notice_at: string | null;
  version: number;
}

const BREAKER_COLUMNS =
  'id, user_id, source, work_kind, work_id, revision, task_group_id, owner_sb_id, ' +
  'no_progress_count, last_counted_at, last_fingerprint, tripped_at, tripped_fingerprint, ' +
  'last_tripped_at, trip_count, last_notice_at, version';

// ── Fingerprints ─────────────────────────────────────────────────────────────

/** The state columns of a task or graph node that count as progress. */
export interface TaskStateRow {
  status: string;
  outcome: string | null;
  gate_state: string | null;
  gate_attempt: number | null;
  gate_request_revision: number | null;
}

export const TASK_STATE_COLUMNS =
  'status, outcome, gate_state, gate_attempt, gate_request_revision';

/**
 * Claim bookkeeping is not work. claim_graph_task moves a node from pending to
 * in_progress (and a verification gate from open to in_progress), and
 * release_graph_claim moves both back; both bump gate_version as a fence. So
 * a turn that claims and releases, or one whose completion is read before its
 * fire-and-forget boundary release lands, must read the same as one that
 * never claimed. Status in_progress reads as pending, a claimed gate as open,
 * and gate_version is not part of the fingerprint at all. What remains is
 * semantic: a terminal or blocked status, an outcome, a gate opening or a
 * verdict, a retry (gate_attempt) and a new revision.
 */
function workStatus(status: string | null): string | null {
  return status === 'in_progress' ? 'pending' : status;
}

function gateStatus(gateState: string | null): string | null {
  return gateState === 'in_progress' ? 'open' : gateState;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * A task's or graph node's progress fingerprint. Claim columns, the claim
 * fence (gate_version), metadata (the dispatch stamps live there) and
 * `updated_at` are left out, and claimed states read as unclaimed: a turn
 * that claims a node and releases it unfinished made no progress.
 */
export function taskFingerprint(row: TaskStateRow): string {
  return digest([
    'task',
    workStatus(row.status),
    row.outcome ?? null,
    gateStatus(row.gate_state ?? null),
    row.gate_attempt ?? null,
    row.gate_request_revision ?? null,
  ]);
}

/** A strategy group's progress fingerprint: its status, cursor and task states. */
export function taskGroupFingerprint(
  group: { status: string | null; current_task_index: number | null },
  tasks: Array<{ id: string; status: string; outcome: string | null }>
): string {
  const states = [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => [t.id, workStatus(t.status), t.outcome ?? null]);
  return digest(['task_group', group.status ?? null, group.current_task_index ?? null, states]);
}

// ── Decisions (pure) ─────────────────────────────────────────────────────────

export type AdmissionDecision =
  | { allowed: true; clearTrip: boolean }
  | { allowed: false; trippedAt: string };

/**
 * May the source wake for this item now? A tripped item stays paused until
 * its fingerprint differs from the one it tripped on. An unreadable
 * fingerprint cannot show progress, so a tripped item stays paused.
 */
export function decideAdmission(
  row: Pick<BreakerRow, 'tripped_at' | 'tripped_fingerprint'> | null,
  fingerprint: string | null
): AdmissionDecision {
  if (!row?.tripped_at) return { allowed: true, clearTrip: false };
  if (fingerprint !== null && fingerprint !== row.tripped_fingerprint) {
    return { allowed: true, clearTrip: true };
  }
  return { allowed: false, trippedAt: row.tripped_at };
}

export type AttemptOutcome = 'progress' | 'no_progress' | 'tripped' | 'duplicate' | 'unknown';

export interface AttemptDecision {
  outcome: AttemptOutcome;
  /** The count after this attempt; unchanged for duplicate and unknown. */
  count: number;
  /** Columns to write; null when nothing changes. */
  update: Partial<BreakerRow> | null;
}

/**
 * Account for one completed, admitted attempt.
 *
 * - `unknown`: the current fingerprint could not be read, so no-progress is
 *   unproven and nothing is counted.
 * - `duplicate`: dispatched before the last counted attempt finished, so it
 *   was queued behind that attempt and is not a new one.
 * - `progress`: the fingerprint moved during the turn. The count resets and a
 *   trip clears.
 * - `no_progress` / `tripped`: unchanged. If the item had moved between the
 *   previous counted attempt and this dispatch (someone else made progress),
 *   the run starts again from this attempt.
 */
export function decideCompletedAttempt(
  row: Pick<
    BreakerRow,
    'no_progress_count' | 'last_counted_at' | 'last_fingerprint' | 'tripped_at' | 'trip_count'
  > | null,
  attempt: {
    dispatchedAt: string;
    fingerprintAtDispatch: string;
    fingerprintNow: string | null;
    completedAt: string;
  },
  limit: number = DEFAULT_NO_PROGRESS_LIMIT
): AttemptDecision {
  const current = row?.no_progress_count ?? 0;
  if (attempt.fingerprintNow === null) {
    return { outcome: 'unknown', count: current, update: null };
  }
  if (row?.last_counted_at && Date.parse(attempt.dispatchedAt) < Date.parse(row.last_counted_at)) {
    return { outcome: 'duplicate', count: current, update: null };
  }
  if (attempt.fingerprintNow !== attempt.fingerprintAtDispatch) {
    return {
      outcome: 'progress',
      count: 0,
      update: {
        no_progress_count: 0,
        last_counted_at: attempt.completedAt,
        last_fingerprint: attempt.fingerprintNow,
        tripped_at: null,
        tripped_fingerprint: null,
      },
    };
  }
  const movedSinceLast =
    row?.last_fingerprint != null && row.last_fingerprint !== attempt.fingerprintAtDispatch;
  const count = (movedSinceLast ? 0 : current) + 1;
  const tripNow = count >= Math.max(1, limit) && !row?.tripped_at;
  return {
    outcome: tripNow ? 'tripped' : 'no_progress',
    count,
    update: {
      no_progress_count: count,
      last_counted_at: attempt.completedAt,
      last_fingerprint: attempt.fingerprintNow,
      ...(tripNow
        ? {
            tripped_at: attempt.completedAt,
            tripped_fingerprint: attempt.fingerprintNow,
            last_tripped_at: attempt.completedAt,
            trip_count: (row?.trip_count ?? 0) + 1,
          }
        : {}),
    },
  };
}

/**
 * Parse a `wakeSource` tag off message metadata. Null unless every field is
 * valid and the signature proves this server issued it, unchanged.
 */
export function parseWakeSourceTag(metadata: unknown): WakeSourceTag | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).wakeSource;
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!WAKE_SOURCES.includes(t.source as WakeSource)) return null;
  if (!WAKE_WORK_KINDS.includes(t.workKind as WakeWorkKind)) return null;
  if (!str(t.workId) || !str(t.fingerprint) || !str(t.dispatchedAt)) return null;
  if (typeof t.revision !== 'string') return null;
  if (Number.isNaN(Date.parse(t.dispatchedAt))) return null;
  if (!str(t.signature) || !/^[0-9a-f]{64}$/.test(t.signature)) return null;
  const fields: WakeSourceTagFields = {
    source: t.source as WakeSource,
    workKind: t.workKind as WakeWorkKind,
    workId: t.workId,
    revision: t.revision,
    fingerprint: t.fingerprint,
    dispatchedAt: t.dispatchedAt,
    taskGroupId: str(t.taskGroupId) ? t.taskGroupId : null,
    ownerSbId: str(t.ownerSbId) ? t.ownerSbId : null,
  };
  if (!signatureMatches(fields, t.signature)) return null;
  return { ...fields, signature: t.signature };
}

// ── Service ──────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<WakeSource, string> = {
  strategy_watchdog: 'the strategy watchdog',
  graph_dispatch: 'graph dispatch',
  reminder_work: 'a work reminder',
};

const RESUME_HINT: Record<WakeSource, string> = {
  strategy_watchdog:
    'The strategy is paused at its next watchdog check. resume_strategy restarts it with a fresh count.',
  graph_dispatch:
    'The node is not re-dispatched until its state changes. start_graph_execution on the group restarts dispatch with a fresh count.',
  reminder_work: 'The reminder does not fire for this item until its state changes.',
};

export interface WakeSourceBreakerOptions {
  noProgressLimit?: number;
  /** Who triages trip notices; `myra` by default. */
  notifySlug?: string;
  now?: () => Date;
}

/** Thrown inside the CAS loop when another writer won the row. */
class VersionConflict extends Error {}

/** What an explicit resume writes: a fresh count, no trip. */
const CLEARED = {
  no_progress_count: 0,
  last_fingerprint: null,
  tripped_at: null,
  tripped_fingerprint: null,
};

export class WakeSourceBreaker {
  private readonly limit: number;
  private readonly notifySlug: string;
  private readonly now: () => Date;

  constructor(
    private readonly dataComposer: DataComposer,
    options: WakeSourceBreakerOptions = {}
  ) {
    this.limit = options.noProgressLimit ?? DEFAULT_NO_PROGRESS_LIMIT;
    this.notifySlug = options.notifySlug ?? DEFAULT_BREAKER_NOTIFY_SLUG;
    this.now = options.now ?? (() => new Date());
  }

  private get client() {
    return this.dataComposer.getClient();
  }

  /** The work item's fingerprint now, or null when it cannot be read. */
  async readFingerprint(
    userId: string,
    workKind: WakeWorkKind,
    workId: string
  ): Promise<string | null> {
    try {
      if (workKind === 'task_group') {
        const { data: group, error } = await this.client
          .from('task_groups')
          .select('status, current_task_index')
          .eq('id', workId)
          .eq('user_id', userId)
          .maybeSingle();
        if (error || !group) return null;
        const { data: tasks, error: tasksError } = await this.client
          .from('tasks')
          .select('id, status, outcome')
          .eq('task_group_id', workId)
          .eq('user_id', userId);
        if (tasksError || !tasks) return null;
        return taskGroupFingerprint(group, tasks);
      }
      const states = await this.readTaskStates(userId, [workId]);
      return states.get(workId)?.fingerprint ?? null;
    } catch (err) {
      logger.warn('[WakeBreaker] Fingerprint read failed', {
        workKind,
        workId,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Fingerprints and revisions for several tasks in one read. A task missing
   * from the map could not be read.
   */
  async readTaskStates(
    userId: string,
    taskIds: string[]
  ): Promise<Map<string, { fingerprint: string; revision: string }>> {
    const out = new Map<string, { fingerprint: string; revision: string }>();
    if (taskIds.length === 0) return out;
    try {
      const { data, error } = await this.client
        .from('tasks')
        .select(`id, ${TASK_STATE_COLUMNS}`)
        .eq('user_id', userId)
        .in('id', taskIds);
      if (error || !data) return out;
      for (const row of data as unknown as Array<TaskStateRow & { id: string }>) {
        out.set(row.id, {
          fingerprint: taskFingerprint(row),
          revision: String(row.gate_request_revision ?? 0),
        });
      }
    } catch (err) {
      logger.warn('[WakeBreaker] Task state read failed', { error: String(err) });
    }
    return out;
  }

  /**
   * The source's fire decision for one item. Fails open on a read error: an
   * unreadable breaker must not stop a source that worked before it existed.
   */
  async admit(key: WakeSourceKey, fingerprint: string | null): Promise<AdmissionDecision> {
    const decisions = await this.admitMany(key.userId, key.source, [
      { workId: key.workId, revision: key.revision, fingerprint },
    ]);
    return decisions.get(key.workId) ?? { allowed: true, clearTrip: false };
  }

  /** admit() for several items of one source, in one read. */
  async admitMany(
    userId: string,
    source: WakeSource,
    items: Array<{ workId: string; revision: string; fingerprint: string | null }>
  ): Promise<Map<string, AdmissionDecision>> {
    const decisions = new Map<string, AdmissionDecision>();
    if (items.length === 0) return decisions;
    let rows: BreakerRow[];
    try {
      const { data, error } = await this.client
        .from('wake_source_breakers')
        .select(BREAKER_COLUMNS)
        .eq('user_id', userId)
        .eq('source', source)
        .in(
          'work_id',
          items.map((i) => i.workId)
        );
      if (error) throw error;
      rows = (data ?? []) as unknown as BreakerRow[];
    } catch (err) {
      logger.warn('[WakeBreaker] Breaker read failed; admitting', { source, error: String(err) });
      return decisions;
    }
    for (const item of items) {
      const row = rows.find((r) => r.work_id === item.workId && r.revision === item.revision);
      const decision = decideAdmission(row ?? null, item.fingerprint);
      decisions.set(item.workId, decision);
      if (row && decision.allowed && decision.clearTrip) {
        // Progress since the trip: the item resumes with a fresh count.
        await this.writeRow(row, {
          no_progress_count: 0,
          tripped_at: null,
          tripped_fingerprint: null,
        }).catch((err) =>
          logger.warn('[WakeBreaker] Clearing a trip failed', { rowId: row.id, error: String(err) })
        );
        logger.info('[WakeBreaker] Trip cleared by progress', {
          source,
          workId: item.workId,
        });
      }
    }
    return decisions;
  }

  /**
   * Record one completed, admitted attempt. Called by the trigger handler after
   * the wake's turn returned successfully. Never throws: accounting must not
   * fail a delivered turn.
   */
  async recordCompletedAttempt(
    userId: string,
    tag: WakeSourceTag
  ): Promise<{ outcome: AttemptOutcome; count: number }> {
    try {
      const fingerprintNow = await this.readFingerprint(userId, tag.workKind, tag.workId);
      const completedAt = this.now().toISOString();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const row = await this.loadOrCreateRow(userId, tag);
        const decision = decideCompletedAttempt(
          row,
          {
            dispatchedAt: tag.dispatchedAt,
            fingerprintAtDispatch: tag.fingerprint,
            fingerprintNow,
            completedAt,
          },
          this.limit
        );
        if (!decision.update) return { outcome: decision.outcome, count: decision.count };
        try {
          await this.writeRow(row, decision.update);
        } catch (err) {
          if (err instanceof VersionConflict) continue;
          throw err;
        }
        if (decision.outcome === 'tripped') {
          await this.notifyTrip(userId, tag, row, decision.count, completedAt);
        }
        logger.info('[WakeBreaker] Attempt recorded', {
          source: tag.source,
          workId: tag.workId,
          outcome: decision.outcome,
          count: decision.count,
        });
        return { outcome: decision.outcome, count: decision.count };
      }
      logger.warn('[WakeBreaker] Gave up recording an attempt after repeated conflicts', {
        source: tag.source,
        workId: tag.workId,
      });
      return { outcome: 'unknown', count: 0 };
    } catch (err) {
      logger.warn('[WakeBreaker] Recording an attempt failed', {
        source: tag.source,
        workId: tag.workId,
        error: String(err),
      });
      return { outcome: 'unknown', count: 0 };
    }
  }

  /** Clear one item's count and trip (an explicit resume). */
  async reset(key: WakeSourceKey): Promise<void> {
    await this.resetMatching({
      user_id: key.userId,
      source: key.source,
      work_id: key.workId,
      revision: key.revision,
    });
  }

  /** Clear every item of one source in a group (strategy resume, graph restart). */
  async resetGroup(userId: string, source: WakeSource, taskGroupId: string): Promise<void> {
    await this.resetMatching({ user_id: userId, source, task_group_id: taskGroupId });
  }

  /**
   * A reset is a compare-and-set per row that advances `version`, so a
   * completion that read the row before the reset loses its own CAS and
   * re-reads instead of writing its stale count over the reset. The reset also
   * moves `last_counted_at` to now: an attempt dispatched before it is then a
   * duplicate (decideCompletedAttempt) and is excluded, never restored.
   */
  private async resetMatching(filters: Record<string, string>): Promise<void> {
    try {
      const resetAt = this.now().toISOString();
      let query = this.client.from('wake_source_breakers').select('id, version');
      for (const [column, value] of Object.entries(filters)) {
        query = query.eq(column as never, value as never);
      }
      const { data, error } = await query;
      if (error) throw error;
      for (const row of (data ?? []) as unknown as Array<{ id: string; version: number }>) {
        let version = row.version;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const { data: written, error: writeError } = await this.client
            .from('wake_source_breakers')
            .update({ ...CLEARED, last_counted_at: resetAt, version: version + 1 })
            .eq('id', row.id)
            .eq('version', version)
            .select('id');
          if (writeError) throw writeError;
          if (written && written.length > 0) break;
          const { data: fresh, error: readError } = await this.client
            .from('wake_source_breakers')
            .select('id, version')
            .eq('id', row.id)
            .maybeSingle();
          if (readError) throw readError;
          if (!fresh) break;
          version = (fresh as unknown as { version: number }).version;
        }
      }
    } catch (err) {
      logger.warn('[WakeBreaker] Reset failed', { filters, error: String(err) });
    }
  }

  private async loadOrCreateRow(userId: string, tag: WakeSourceTag): Promise<BreakerRow> {
    const select = () =>
      this.client
        .from('wake_source_breakers')
        .select(BREAKER_COLUMNS)
        .eq('user_id', userId)
        .eq('source', tag.source)
        .eq('work_id', tag.workId)
        .eq('revision', tag.revision)
        .maybeSingle();
    const { data, error } = await select();
    if (error) throw error;
    if (data) return data as unknown as BreakerRow;
    const { error: insertError } = await this.client.from('wake_source_breakers').upsert(
      {
        user_id: userId,
        source: tag.source,
        work_kind: tag.workKind,
        work_id: tag.workId,
        revision: tag.revision,
        task_group_id: tag.taskGroupId,
        owner_sb_id: tag.ownerSbId,
      },
      { onConflict: 'user_id,source,work_id,revision', ignoreDuplicates: true }
    );
    if (insertError) throw insertError;
    const { data: created, error: reread } = await select();
    if (reread || !created) throw reread ?? new Error('breaker row missing after insert');
    return created as unknown as BreakerRow;
  }

  private async writeRow(row: BreakerRow, update: Partial<BreakerRow>): Promise<void> {
    const { data, error } = await this.client
      .from('wake_source_breakers')
      .update({ ...update, version: row.version + 1 })
      .eq('id', row.id)
      .eq('version', row.version)
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) throw new VersionConflict();
  }

  /**
   * One notice per trip: a comment on the work item, where its owner works,
   * and a message to Myra, who decides whether Conor hears now or in the
   * morning. Only the writer whose CAS set the trip gets here, so a trip is
   * announced once.
   */
  private async notifyTrip(
    userId: string,
    tag: WakeSourceTag,
    before: BreakerRow,
    count: number,
    trippedAt: string
  ): Promise<void> {
    const ownerSlug = tag.ownerSbId
      ? await resolveSbSlug(this.client, tag.ownerSbId).catch(() => null)
      : null;
    const title = await this.workTitle(userId, tag);
    const previous = before.last_tripped_at;
    const text = [
      `No-progress breaker tripped: ${SOURCE_LABEL[tag.source]} woke ${ownerSlug ?? 'its owner'} ` +
        `${count} times in a row for ${tag.workKind.replace('_', ' ')} "${title}" (${tag.workId}), ` +
        `and each turn ended with its state unchanged.`,
      RESUME_HINT[tag.source],
      'Any change to its state (status, outcome or gate) also resumes it. Human messages and replies still deliver.',
      previous ? `It last tripped at ${previous}.` : null,
    ]
      .filter(Boolean)
      .join(' ');

    await this.commentOnWork(userId, tag, text).catch((err) =>
      logger.warn('[WakeBreaker] Trip comment failed', { workId: tag.workId, error: String(err) })
    );
    await this.messageTriage(userId, tag, text, trippedAt, previous).catch((err) =>
      logger.warn('[WakeBreaker] Trip notice to triage failed', {
        workId: tag.workId,
        error: String(err),
      })
    );
    try {
      await this.client
        .from('wake_source_breakers')
        .update({ last_notice_at: this.now().toISOString() })
        .eq('id', before.id);
    } catch {
      // The notice went out; failing to stamp it only loses the timestamp.
    }
  }

  private async workTitle(userId: string, tag: WakeSourceTag): Promise<string> {
    const table = tag.workKind === 'task_group' ? 'task_groups' : 'tasks';
    const { data } = await this.client
      .from(table)
      .select('title')
      .eq('id', tag.workId)
      .eq('user_id', userId)
      .maybeSingle();
    return (data as { title?: string } | null)?.title ?? tag.workId;
  }

  private async commentOnWork(userId: string, tag: WakeSourceTag, text: string): Promise<void> {
    if (tag.workKind === 'task_group') {
      const { error } = await this.client.from('task_group_comments').insert({
        task_group_id: tag.workId,
        user_id: userId,
        content: text,
        comment_type: 'status_change',
        agent_id: 'system',
        metadata: { wakeBreaker: { source: tag.source } },
      });
      if (error) throw error;
      return;
    }
    const { error } = await this.client.from('task_comments').insert({
      task_id: tag.workId,
      user_id: userId,
      content: text,
      created_by_agent_id: 'system',
      metadata: { wakeBreaker: { source: tag.source } },
    });
    if (error) throw error;
  }

  private async messageTriage(
    userId: string,
    tag: WakeSourceTag,
    text: string,
    trippedAt: string,
    previousTrippedAt: string | null
  ): Promise<void> {
    let workspaceId: string | null = null;
    if (tag.ownerSbId) {
      const { data } = await this.client
        .from('agent_identities')
        .select('workspace_id')
        .eq('id', tag.ownerSbId)
        .maybeSingle();
      workspaceId = (data as { workspace_id?: string | null } | null)?.workspace_id ?? null;
    }
    const triageSbId = await resolveSbId(
      this.client,
      userId,
      this.notifySlug,
      workspaceId ?? undefined
    );
    if (!triageSbId) {
      logger.warn('[WakeBreaker] No triage identity to notify', { notifySlug: this.notifySlug });
      return;
    }
    const { handleSendToInbox } = await import('../mcp/tools/inbox-handlers.js');
    await handleSendToInbox(
      {
        userId,
        recipientSlug: this.notifySlug,
        threadKey: `ops:wake-breaker:${tag.source}`,
        messageType: 'notification',
        priority: 'normal',
        subject: `No-progress breaker tripped (${tag.source})`,
        content: text,
        metadata: {
          wakeBreaker: {
            source: tag.source,
            workKind: tag.workKind,
            workId: tag.workId,
            trippedAt,
            previousTrippedAt,
          },
        },
      },
      this.dataComposer,
      { sender: { principal: SYSTEM_PRINCIPAL, workspaceId } }
    );
  }
}

/**
 * The trigger handler's hook: a wake turn returned successfully, so record
 * the attempt if the message carried a wake-source tag. Messages without one
 * (human messages, replies, heartbeats) are ignored.
 */
export async function recordWakeSourceCompletion(
  dataComposer: DataComposer,
  userId: string,
  metadata: unknown,
  breaker: WakeSourceBreaker = new WakeSourceBreaker(dataComposer)
): Promise<{ outcome: AttemptOutcome; count: number } | null> {
  const tag = parseWakeSourceTag(metadata);
  if (!tag) return null;
  return breaker.recordCompletedAttempt(userId, tag);
}

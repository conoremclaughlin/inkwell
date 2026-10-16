/**
 * Server-only delivery references, not a transcript or a reader cursor.
 * Unwired: callers must prove source/recipient authorization before retain,
 * bind every source before dispatch, and supply server-observed finalization
 * before settlement. This store never dispatches, retries, or decides whether
 * a native transcript contains an input.
 */
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const uuid = z.string().uuid();
const scopeSchema = z.object({ ownerId: uuid, recipientId: uuid, sessionId: uuid }).strict();
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), messageId: uuid }).strict(),
  z.object({ kind: z.literal('inbox'), messageId: uuid }).strict(),
]);
const launchSchema = z
  .object({
    launchId: uuid,
    turnEpoch: uuid,
    // Null is uncorrelated, never evidence that an input was not delivered.
    native: z
      .object({ sessionId: z.string().min(1).max(256), inputId: uuid })
      .strict()
      .nullable(),
  })
  .strict();
const rowFields = z
  .object({
    id: uuid,
    owner_id: uuid,
    recipient_id: uuid,
    session_id: uuid,
    thread_message_id: uuid.nullable(),
    inbox_message_id: uuid.nullable(),
    state: z.enum(['pending', 'bound', 'held', 'settled']),
    revision: z.number().int().min(0).max(2_147_483_647),
    launch_id: uuid.nullable(),
    turn_epoch: uuid.nullable(),
    native_session_id: z.string().min(1).max(256).nullable(),
    native_input_id: uuid.nullable(),
    created_at: z.string().datetime({ offset: true }),
    changed_at: z.string().datetime({ offset: true }),
    settled_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
const rowSchema = rowFields
  .refine((row) => (row.thread_message_id === null) !== (row.inbox_message_id === null))
  .refine((row) =>
    row.state === 'pending'
      ? row.launch_id === null && row.turn_epoch === null && row.native_session_id === null
      : row.launch_id !== null && row.turn_epoch !== null
  )
  .refine((row) => (row.native_session_id === null) === (row.native_input_id === null))
  .refine((row) => (row.state === 'settled') === (row.settled_at !== null));

export type RetainedInboxScope = z.infer<typeof scopeSchema>;
export type RetainedInboxSource = z.infer<typeof sourceSchema>;
export type RetainedInboxLaunch = z.infer<typeof launchSchema>;
export type RetainedInboxDelivery = Readonly<z.infer<typeof rowSchema>>;
export type RetainedInboxWrite =
  | { status: 'written'; delivery: RetainedInboxDelivery }
  | { status: 'conflict' }
  | { status: 'unknown' };

const table = 'sb_inbox_deliveries';
const columns = Object.keys(rowFields.shape).join(',');

function readRow(value: unknown): RetainedInboxDelivery {
  const row = rowSchema.parse(value);
  // PostgREST renders timestamptz as +00:00, not the writer's ISO Z spelling.
  // These are diagnostic dates, not CAS fences; compare their instants.
  return Object.freeze({
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    changed_at: new Date(row.changed_at).toISOString(),
    settled_at: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  });
}

/** No global client, environment loader, logger, or credential fallback. */
export function retainedInboxStore(client: SupabaseClient) {
  return {
    /**
     * One INSERT for the entire batch. No upsert: an existing obligation,
     * including a settled one, cannot be replaced by a later run. An error or
     * lost response means do not dispatch; discover the original rows instead.
     * Both initial prompts and mid-run corrections use this same ownership.
     */
    async retain(
      scopeInput: RetainedInboxScope,
      sourceInputs: readonly RetainedInboxSource[]
    ): Promise<readonly RetainedInboxDelivery[]> {
      const scope = scopeSchema.parse(scopeInput);
      const sources = z.array(sourceSchema).min(1).max(100).parse(sourceInputs);
      const keys = new Set(sources.map((source) => `${source.kind}:${source.messageId}`));
      if (keys.size !== sources.length) throw new Error('Duplicate retained input source');
      const rows = sources.map((source) => ({
        id: randomUUID(),
        owner_id: scope.ownerId,
        recipient_id: scope.recipientId,
        session_id: scope.sessionId,
        thread_message_id: source.kind === 'thread' ? source.messageId : null,
        inbox_message_id: source.kind === 'inbox' ? source.messageId : null,
      }));
      try {
        const { data, error } = await client.from(table).insert(rows).select(columns);
        if (error || !Array.isArray(data) || data.length !== rows.length) throw new Error();
        const returned = data.map(readRow);
        // Match every generated id and source, not just a count or return order.
        const byId = new Map(returned.map((row) => [row.id, row]));
        if (byId.size !== rows.length) throw new Error();
        return Object.freeze(
          rows.map((expected) => {
            const row = byId.get(expected.id);
            if (
              !row ||
              row.state !== 'pending' ||
              row.revision !== 0 ||
              Object.entries(expected).some(
                ([key, value]) => row[key as keyof typeof row] !== value
              )
            )
              throw new Error();
            return row;
          })
        );
      } catch {
        // Never include a backend exception or source text in this error.
        throw new Error('Input retention was not confirmed; do not dispatch');
      }
    },

    /**
     * Bind before launch/pipe write. A shortfall for any member prevents the
     * batch from dispatching; bindings already written remain discoverable.
     * The caller must also validate the reserved launch belongs to this run.
     */
    async bind(
      expectedInput: RetainedInboxDelivery,
      launchInput: RetainedInboxLaunch
    ): Promise<RetainedInboxWrite> {
      const expected = readRow(expectedInput);
      const launch = launchSchema.parse(launchInput);
      if (expected.state !== 'pending') return { status: 'conflict' };
      return change(expected, {
        state: 'bound',
        launch_id: launch.launchId,
        turn_epoch: launch.turnEpoch,
        native_session_id: launch.native?.sessionId ?? null,
        native_input_id: launch.native?.inputId ?? null,
      });
    },

    /** Ambiguous death/dispatch remains retained. No expiry-based retry. */
    async hold(expectedInput: RetainedInboxDelivery): Promise<RetainedInboxWrite> {
      const expected = readRow(expectedInput);
      if (expected.state !== 'bound') return { status: 'conflict' };
      return change(expected, { state: 'held' });
    },

    /**
     * Only the server's confirmed whole-run finalization/delivery boundary may
     * call this. A receipt, runner success, lifecycle or ended_at is not that
     * boundary. Held rows need separate recovery adjudication, not this method.
     * A failed write leaves the obligation retained; it never authorizes replay.
     */
    async settleAfterFinalization(
      expectedInput: RetainedInboxDelivery
    ): Promise<RetainedInboxWrite> {
      const expected = readRow(expectedInput);
      if (expected.state !== 'bound') return { status: 'conflict' };
      return change(expected, { state: 'settled', settled_at: new Date().toISOString() });
    },

    /** Keyset page. No user/SB read pointer participates in recovery discovery. */
    async listUnsettled(
      scopeInput: RetainedInboxScope,
      afterId?: string,
      limit = 100
    ): Promise<readonly RetainedInboxDelivery[]> {
      const scope = scopeSchema.parse(scopeInput);
      if (afterId !== undefined) uuid.parse(afterId);
      z.number().int().min(1).max(100).parse(limit);
      try {
        let query = client
          .from(table)
          .select(columns)
          .eq('owner_id', scope.ownerId)
          .eq('recipient_id', scope.recipientId)
          .eq('session_id', scope.sessionId)
          .neq('state', 'settled');
        if (afterId !== undefined) query = query.gt('id', afterId);
        const { data, error } = await query.order('id', { ascending: true }).limit(limit);
        if (error || !Array.isArray(data) || data.length > limit) throw new Error();
        let previous = afterId;
        const rows = data.map((value) => {
          const row = readRow(value);
          if (
            row.owner_id !== scope.ownerId ||
            row.recipient_id !== scope.recipientId ||
            row.session_id !== scope.sessionId ||
            row.state === 'settled' ||
            (previous !== undefined && row.id <= previous)
          )
            throw new Error();
          previous = row.id;
          return row;
        });
        return Object.freeze(rows);
      } catch {
        throw new Error('Retained input discovery failed; absence is not established');
      }
    },
  };

  async function change(
    expected: RetainedInboxDelivery,
    patch: Partial<RetainedInboxDelivery>
  ): Promise<RetainedInboxWrite> {
    if (expected.revision === 2_147_483_647) return { status: 'conflict' };
    const changes = {
      ...patch,
      revision: expected.revision + 1,
      changed_at: new Date().toISOString(),
    };
    try {
      let query = client.from(table).update(changes);
      // Fence every identity and native correlation field, not mutable read state
      // or timestamps. A caller cannot retarget another session/launch/source.
      const fences = {
        id: expected.id,
        owner_id: expected.owner_id,
        recipient_id: expected.recipient_id,
        session_id: expected.session_id,
        thread_message_id: expected.thread_message_id,
        inbox_message_id: expected.inbox_message_id,
        state: expected.state,
        revision: expected.revision,
        launch_id: expected.launch_id,
        turn_epoch: expected.turn_epoch,
        native_session_id: expected.native_session_id,
        native_input_id: expected.native_input_id,
      };
      for (const [key, value] of Object.entries(fences))
        query = value === null ? query.is(key, null) : query.eq(key, value);
      const { data, error } = await query.select(columns).maybeSingle();
      if (error) return { status: 'unknown' };
      if (data === null) return { status: 'conflict' };
      const delivery = readRow(data);
      const intended = { ...expected, ...changes };
      if (
        Object.entries(intended).some(
          ([key, value]) => delivery[key as keyof typeof delivery] !== value
        )
      )
        return { status: 'unknown' };
      return { status: 'written', delivery };
    } catch {
      return { status: 'unknown' };
    }
  }
}

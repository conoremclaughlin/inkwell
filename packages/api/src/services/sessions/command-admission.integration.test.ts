/**
 * Durable command admission (migration 20261004094856) and owner tenure with
 * turn generations (20261004104039) against a real database: ordering, dedupe,
 * mode binding, transitions, the unknown-effect hold, holder authority, turn
 * serialization and release evidence. These are the invariants concurrency or
 * Postgres semantics decide, so a mock cannot stand in for them.
 *
 * The suite flips the global admission mode to `conditional` and restores
 * `legacy` afterwards. Both migrations' tests live in this one file because
 * integration files run in parallel and every one of these reads that row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDataComposer } from '../../data/composer';
import { ensureEchoIntegrationFixture, ensureSuiteIdentity } from '../../test/integration-fixtures';
import {
  ADMISSION_PROTOCOL,
  admitCommand,
  readDispatchHead,
  transitionCommand,
  type AdmitCommandInput,
} from './command-admission';
import {
  admitTurn,
  finishTurn,
  markTenureLost,
  mintTenureCapability,
  reconcileTenure,
  recordInvocation,
  registerTenure,
  releaseTenure,
  type InvocationRecord,
  type LegacySessionState,
  type TenureHolder,
  type TenureMode,
} from './tenure-admission';

const SUITE_SB = 'command-admission-suite';
const OTHER_SB = 'command-admission-other';
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('durable command admission', () => {
  let supabase: SupabaseClient;
  let userId: string;
  let workspaceId: string;
  let suiteSbId: string;
  let otherUserId: string | undefined;
  let otherWorkspaceId: string;
  const sessionIds: string[] = [];
  const threadIds: string[] = [];

  async function newSession(sbId: string | null): Promise<string> {
    const { data, error } = await supabase
      .from('sessions')
      .insert({ user_id: userId, agent_id: SUITE_SB, sb_id: sbId, status: 'active' })
      .select('id')
      .single();
    if (error || !data) throw new Error(`session insert failed: ${error?.message}`);
    sessionIds.push(data.id as string);
    return data.id as string;
  }

  async function newMessage(ws: string, creatorSbId: string, creatorSlug: string): Promise<string> {
    const { data: thread, error: threadErr } = await supabase
      .from('inbox_threads')
      .insert({
        thread_key: `test:command-admission-${RUN}-${threadIds.length}`,
        workspace_id: ws,
        created_by_kind: 'sb',
        created_by_sb_id: creatorSbId,
        title: 'command admission',
        status: 'open',
      })
      .select('id')
      .single();
    if (threadErr || !thread) throw new Error(`thread insert failed: ${threadErr?.message}`);
    threadIds.push(thread.id as string);
    const { error: partErr } = await supabase
      .from('inbox_thread_participants')
      .insert({ thread_id: thread.id, workspace_id: ws, sb_id: creatorSbId });
    if (partErr) throw new Error(`participant insert failed: ${partErr.message}`);
    const { data: message, error: msgErr } = await supabase
      .from('inbox_thread_messages')
      .insert({
        thread_id: thread.id,
        sender_kind: 'sb',
        sender_sb_id: creatorSbId,
        sender_agent_id: creatorSlug,
        content: 'invented fixture message',
        message_type: 'message',
      })
      .select('id')
      .single();
    if (msgErr || !message) throw new Error(`message insert failed: ${msgErr?.message}`);
    return message.id as string;
  }

  async function setMode(mode: 'legacy' | 'conditional'): Promise<void> {
    const { error } = await supabase
      .from('runtime_admission_mode')
      .update({ mode, changed_reason: `command-admission suite ${RUN}` })
      .eq('singleton', true);
    if (error) throw new Error(`mode update failed: ${error.message}`);
  }

  function input(sessionId: string, overrides: Partial<AdmitCommandInput> = {}): AdmitCommandInput {
    return {
      sessionId,
      workspaceId,
      principal: { kind: 'user', id: userId },
      commandId: randomUUID(),
      kind: 'input.enqueue',
      origin: { kind: 'terminal' },
      payload: { text: 'invented input' },
      ...overrides,
    };
  }

  beforeAll(async () => {
    const dataComposer = await getDataComposer();
    supabase = dataComposer.getClient();
    const fixture = await ensureEchoIntegrationFixture(dataComposer);
    userId = fixture.userId;
    workspaceId = fixture.workspaceId;
    suiteSbId = await ensureSuiteIdentity(dataComposer, fixture, SUITE_SB);

    // A second person, whose personal workspace the database provisions.
    otherUserId = randomUUID();
    const { error: userErr } = await supabase
      .from('users')
      .insert({ id: otherUserId, email: `command-admission-${RUN}@integration.test` });
    if (userErr) throw new Error(`other user insert failed: ${userErr.message}`);
    const { data: personal } = await supabase
      .from('workspaces')
      .select('id')
      .eq('user_id', otherUserId)
      .eq('slug', 'personal')
      .maybeSingle();
    if (!personal?.id) throw new Error('other personal workspace was not provisioned');
    otherWorkspaceId = personal.id as string;

    await setMode('conditional');
  }, 30_000);

  afterAll(async () => {
    if (!supabase) return;
    await setMode('legacy');
    if (sessionIds.length) await supabase.from('sessions').delete().in('id', sessionIds);
    for (const threadId of threadIds) {
      await supabase.from('inbox_thread_messages').delete().eq('thread_id', threadId);
      await supabase.from('inbox_thread_participants').delete().eq('thread_id', threadId);
      await supabase.from('inbox_threads').delete().eq('id', threadId);
    }
    if (suiteSbId) await supabase.from('agent_identities').delete().eq('id', suiteSbId);
    if (otherUserId) {
      await supabase.from('agent_identities').delete().eq('user_id', otherUserId);
      await supabase.from('users').delete().eq('id', otherUserId);
    }
  }, 30_000);

  describe('mode binding', () => {
    it('refuses in legacy mode and on a protocol the database does not speak', async () => {
      const sessionId = await newSession(suiteSbId);
      await setMode('legacy');
      try {
        expect(await admitCommand(supabase, input(sessionId))).toEqual({
          outcome: 'mode_mismatch',
          mode: 'legacy',
          protocol: ADMISSION_PROTOCOL,
        });
      } finally {
        await setMode('conditional');
      }
      const { data } = await supabase.rpc('admit_command', {
        p_session_id: sessionId,
        p_workspace_id: workspaceId,
        p_principal_kind: 'user',
        p_principal_id: userId,
        p_command_id: randomUUID(),
        p_payload_digest: 'sha256:x',
        p_digest_version: 1,
        p_kind: 'input.enqueue',
        p_origin_kind: 'terminal',
        p_origin_ref: null,
        p_addressee: null,
        p_payload: { text: 'x' },
        p_source_message_ref: null,
        p_expected_turn: null,
        p_recipients: [],
        p_protocol: ADMISSION_PROTOCOL + 1,
      });
      expect(data).toMatchObject({ outcome: 'mode_mismatch', mode: 'conditional' });
      const { count } = await supabase
        .from('session_commands')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId);
      expect(count).toBe(0);
    });
  });

  describe('order and identity', () => {
    it('gives concurrent admissions one gapless order', async () => {
      const sessionId = await newSession(suiteSbId);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => admitCommand(supabase, input(sessionId)))
      );
      const seqs = results.map((r) => (r.outcome === 'admitted' ? r.admissionSeq : -1));
      expect(seqs.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    });

    it('returns the existing command for the same id and digest, and conflicts on a different one', async () => {
      const sessionId = await newSession(suiteSbId);
      const first = input(sessionId);
      const admitted = await admitCommand(supabase, first);
      expect(admitted).toMatchObject({ outcome: 'admitted', admissionSeq: 1, revision: 1 });
      if (admitted.outcome !== 'admitted') return;

      const concurrent = await Promise.all(
        Array.from({ length: 6 }, () => admitCommand(supabase, first))
      );
      for (const r of concurrent) {
        expect(r).toMatchObject({ outcome: 'existing', id: admitted.id, admissionSeq: 1 });
      }
      expect(
        await admitCommand(supabase, { ...first, payload: { text: 'a different body' } })
      ).toEqual({ outcome: 'conflict', id: admitted.id });
      // The same id aimed at another turn is a different command, not a repeat.
      expect(await admitCommand(supabase, { ...first, expectedTurn: 'another-turn' })).toEqual({
        outcome: 'conflict',
        id: admitted.id,
      });
    });

    // Lumen, pr:701 9a5d87ef A3: the old addressee was acknowledged for a new one.
    it('conflicts when only the addressee or the origin changes under the same id and body', async () => {
      const sessionId = await newSession(suiteSbId);
      const first = input(sessionId, { origin: { kind: 'browser' }, addressee: 'fixture-alpha' });
      const admitted = await admitCommand(supabase, first);
      if (admitted.outcome !== 'admitted') throw new Error(`unexpected ${admitted.outcome}`);
      for (const changed of [
        { addressee: 'fixture-beta' },
        { addressee: undefined },
        { origin: { kind: 'terminal' as const } },
        { origin: { kind: 'browser' as const, ref: 'tab-2' } },
      ]) {
        expect(await admitCommand(supabase, { ...first, ...changed })).toEqual({
          outcome: 'conflict',
          id: admitted.id,
        });
      }
      expect(await admitCommand(supabase, first)).toMatchObject({
        outcome: 'existing',
        id: admitted.id,
      });
    });

    it('compares the envelope itself, not only the digest the caller sends', async () => {
      const sessionId = await newSession(suiteSbId);
      const args = {
        p_session_id: sessionId,
        p_workspace_id: workspaceId,
        p_principal_kind: 'user',
        p_principal_id: userId,
        p_command_id: randomUUID(),
        p_payload_digest: 'sha256:caller-digest-without-the-addressee',
        p_digest_version: 1,
        p_kind: 'input.enqueue',
        p_origin_kind: 'browser',
        p_origin_ref: null,
        p_addressee: 'fixture-alpha',
        p_payload: { text: 'invented input' },
        p_source_message_ref: null,
        p_expected_turn: null,
        p_recipients: [],
        p_protocol: ADMISSION_PROTOCOL,
      };
      const { data: first } = await supabase.rpc('admit_command', args);
      expect(first).toMatchObject({ outcome: 'admitted' });
      // Each field alone, under the same caller digest.
      for (const changed of [
        { p_addressee: 'fixture-beta' },
        { p_origin_kind: 'terminal' },
        { p_origin_ref: 'tab-2' },
        { p_kind: 'session.compact' },
        { p_expected_turn: 'another-turn' },
        { p_source_message_ref: randomUUID() },
      ]) {
        const { data: again } = await supabase.rpc('admit_command', { ...args, ...changed });
        expect({ changed, again }).toEqual({
          changed,
          again: { outcome: 'conflict', id: first.id },
        });
      }
      const { data: same } = await supabase.rpc('admit_command', args);
      expect(same).toMatchObject({ outcome: 'existing', id: first.id });
    });

    it('records the queued event and the originator receipt with the command', async () => {
      const sessionId = await newSession(suiteSbId);
      const r = await admitCommand(supabase, input(sessionId));
      if (r.outcome !== 'admitted') throw new Error(`unexpected ${r.outcome}`);
      const { data: events } = await supabase
        .from('session_command_events')
        .select('revision, state')
        .eq('command_uuid', r.id);
      expect(events).toEqual([{ revision: 1, state: 'queued' }]);
      const { data: receipts } = await supabase
        .from('session_command_receipts')
        .select('revision, recipient_kind, recipient_id, delivered_at')
        .eq('command_uuid', r.id);
      expect(receipts).toEqual([
        { revision: 1, recipient_kind: 'user', recipient_id: userId, delivered_at: null },
      ]);
    });
  });

  describe('scope and refusals', () => {
    it('refuses a session outside the named workspace, and one with no identity', async () => {
      const sessionId = await newSession(suiteSbId);
      expect(
        await admitCommand(supabase, input(sessionId, { workspaceId: otherWorkspaceId }))
      ).toEqual({ outcome: 'forbidden' });
      const bare = await newSession(null);
      expect(await admitCommand(supabase, input(bare))).toEqual({ outcome: 'forbidden' });
      expect(await admitCommand(supabase, input(randomUUID()))).toEqual({
        outcome: 'session_missing',
      });
    });

    it('refuses a payload over the bound, with no row', async () => {
      const sessionId = await newSession(suiteSbId);
      const r = await admitCommand(
        supabase,
        input(sessionId, { payload: { text: 'x'.repeat(8 * 1024 * 1024) } })
      );
      expect(r).toEqual({ outcome: 'too_large', limitBytes: 8 * 1024 * 1024 });
      const { count } = await supabase
        .from('session_commands')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', sessionId);
      expect(count).toBe(0);
    });

    it('returns invalid for an unknown kind instead of raising', async () => {
      const sessionId = await newSession(suiteSbId);
      const { data } = await supabase.rpc('admit_command', {
        p_session_id: sessionId,
        p_workspace_id: workspaceId,
        p_principal_kind: 'user',
        p_principal_id: userId,
        p_command_id: randomUUID(),
        p_payload_digest: 'sha256:x',
        p_digest_version: 1,
        p_kind: 'turn.steer',
        p_origin_kind: 'terminal',
        p_origin_ref: null,
        p_addressee: null,
        p_payload: { text: 'x' },
        p_source_message_ref: null,
        p_expected_turn: null,
        p_recipients: [],
        p_protocol: ADMISSION_PROTOCOL,
      });
      expect(data).toEqual({ outcome: 'invalid', field: 'kind' });
    });
  });

  describe('Inkmail', () => {
    it('dedupes by message across command ids, and keeps the key when the message goes', async () => {
      const sessionId = await newSession(suiteSbId);
      const messageId = await newMessage(workspaceId, suiteSbId, SUITE_SB);
      const delivery = input(sessionId, {
        origin: { kind: 'inkmail' },
        payload: undefined,
        sourceMessageRef: messageId,
        principal: { kind: 'sb', id: suiteSbId },
      });
      const admitted = await admitCommand(supabase, delivery);
      expect(admitted).toMatchObject({ outcome: 'admitted', admissionSeq: 1 });
      if (admitted.outcome !== 'admitted') return;

      // A transport redelivery under a fresh command id is the same command.
      expect(await admitCommand(supabase, { ...delivery, commandId: randomUUID() })).toMatchObject({
        outcome: 'existing',
        id: admitted.id,
      });

      await supabase.from('inbox_thread_messages').delete().eq('id', messageId);
      const { data: row } = await supabase
        .from('session_commands')
        .select('source_message_ref, source_message_id')
        .eq('id', admitted.id)
        .single();
      expect(row).toEqual({ source_message_ref: messageId, source_message_id: null });
      expect(await admitCommand(supabase, { ...delivery, commandId: randomUUID() })).toMatchObject({
        outcome: 'existing',
        id: admitted.id,
      });
    });

    it('conflicts on a redelivery that changes the envelope, through the message identity too', async () => {
      const sessionId = await newSession(suiteSbId);
      const messageId = await newMessage(workspaceId, suiteSbId, SUITE_SB);
      const delivery = input(sessionId, {
        origin: { kind: 'inkmail' },
        addressee: 'fixture-alpha',
        payload: undefined,
        sourceMessageRef: messageId,
        principal: { kind: 'sb', id: suiteSbId },
      });
      const admitted = await admitCommand(supabase, delivery);
      if (admitted.outcome !== 'admitted') throw new Error(`unexpected ${admitted.outcome}`);
      for (const changed of [
        { addressee: 'fixture-beta' },
        { principal: { kind: 'user' as const, id: userId } },
        { expectedTurn: 'another-turn' },
      ]) {
        expect(
          await admitCommand(supabase, { ...delivery, ...changed, commandId: randomUUID() })
        ).toEqual({ outcome: 'conflict', id: admitted.id });
      }
    });

    it('refuses a message from another workspace, and one that does not exist', async () => {
      const sessionId = await newSession(suiteSbId);
      const { data: otherSb, error } = await supabase
        .from('agent_identities')
        .insert({
          user_id: otherUserId,
          workspace_id: otherWorkspaceId,
          agent_id: OTHER_SB,
          name: OTHER_SB,
          role: 'assistant',
        })
        .select('id')
        .single();
      if (error || !otherSb) throw new Error(`other identity insert failed: ${error?.message}`);
      const foreign = await newMessage(otherWorkspaceId, otherSb.id as string, OTHER_SB);
      const base = {
        origin: { kind: 'inkmail' as const },
        payload: undefined,
        principal: { kind: 'sb' as const, id: suiteSbId },
      };
      expect(
        await admitCommand(supabase, input(sessionId, { ...base, sourceMessageRef: foreign }))
      ).toEqual({ outcome: 'forbidden' });
      expect(
        await admitCommand(supabase, input(sessionId, { ...base, sourceMessageRef: randomUUID() }))
      ).toEqual({ outcome: 'source_unavailable' });
    });
  });

  describe('transitions', () => {
    async function admitted(sessionId: string) {
      const r = await admitCommand(supabase, input(sessionId));
      if (r.outcome !== 'admitted') throw new Error(`unexpected ${r.outcome}`);
      return r;
    }

    it('applies only from the exact revision and state read', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 2, state: 'queued' },
          to: 'backend_accepted',
        })
      ).toEqual({ outcome: 'stale', revision: 1, state: 'queued' });
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 1, state: 'queued' },
          to: 'backend_accepted',
        })
      ).toEqual({ outcome: 'transitioned', revision: 2, state: 'backend_accepted' });
    });

    it('never returns a started command to not-started, and never rejects it', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 1, state: 'queued' },
          to: 'unknown',
          reasonCode: 'acceptance_unresolved',
          recipients: [{ kind: 'operator', id: 'operator-fixture' }],
        })
      ).toEqual({ outcome: 'transitioned', revision: 2, state: 'unknown' });
      for (const to of ['queued', 'waiting_for_consumer', 'rejected'] as const) {
        expect(
          await transitionCommand(supabase, {
            commandUuid: c.id,
            expected: { revision: 2, state: 'unknown' },
            to,
            reasonCode: 'source_unavailable',
          })
        ).toEqual({ outcome: 'illegal_transition', from: 'unknown', to });
      }
      // Evidence may still resolve it.
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 2, state: 'unknown' },
          to: 'completed',
        })
      ).toEqual({ outcome: 'transitioned', revision: 3, state: 'completed' });
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 3, state: 'completed' },
          to: 'unknown',
        })
      ).toEqual({ outcome: 'illegal_transition', from: 'completed', to: 'unknown' });
    });

    it('answers a retry after a lost acknowledgement with stale, and writes nothing twice', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      const move = {
        commandUuid: c.id,
        expected: { revision: 1, state: 'queued' as const },
        to: 'backend_accepted' as const,
      };
      expect(await transitionCommand(supabase, move)).toEqual({
        outcome: 'transitioned',
        revision: 2,
        state: 'backend_accepted',
      });
      // The caller never saw that reply and sends the same transition again:
      // the answer shows where the command now is, so the caller can tell it landed.
      expect(await transitionCommand(supabase, move)).toEqual({
        outcome: 'stale',
        revision: 2,
        state: 'backend_accepted',
      });
      const { count: events } = await supabase
        .from('session_command_events')
        .select('revision', { count: 'exact', head: true })
        .eq('command_uuid', c.id);
      const { count: receipts } = await supabase
        .from('session_command_receipts')
        .select('revision', { count: 'exact', head: true })
        .eq('command_uuid', c.id);
      expect({ events, receipts }).toEqual({ events: 2, receipts: 2 });
    });

    it('lets exactly one of several racing writers move a revision', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          transitionCommand(supabase, {
            commandUuid: c.id,
            expected: { revision: 1, state: 'queued' },
            to: 'backend_accepted',
          })
        )
      );
      expect(results.filter((r) => r.outcome === 'transitioned')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'stale')).toHaveLength(5);
    });

    it('rejects a command that has not started', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 1, state: 'queued' },
          to: 'rejected',
          reasonCode: 'source_unavailable',
        })
      ).toEqual({ outcome: 'transitioned', revision: 2, state: 'rejected' });
    });

    it('refuses a recovery hold without its notice, and records both receipts with it', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 1, state: 'queued' },
          to: 'unknown',
          reasonCode: 'recovery_required',
        })
      ).toEqual({ outcome: 'notice_required' });
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 1, state: 'queued' },
          to: 'unknown',
          reasonCode: 'recovery_required',
          recipients: [{ kind: 'operator', id: 'operator-fixture' }],
        })
      ).toEqual({ outcome: 'transitioned', revision: 2, state: 'unknown' });
      const { data: receipts } = await supabase
        .from('session_command_receipts')
        .select('recipient_kind, recipient_id')
        .eq('command_uuid', c.id)
        .eq('revision', 2)
        .order('recipient_kind');
      expect(receipts).toEqual([
        { recipient_kind: 'operator', recipient_id: 'operator-fixture' },
        { recipient_kind: 'user', recipient_id: userId },
      ]);
    });

    async function writes(commandUuid: string) {
      const { data: row } = await supabase
        .from('session_commands')
        .select('revision, state, started_at')
        .eq('id', commandUuid)
        .single();
      const { count: events } = await supabase
        .from('session_command_events')
        .select('revision', { count: 'exact', head: true })
        .eq('command_uuid', commandUuid);
      const { count: receipts } = await supabase
        .from('session_command_receipts')
        .select('revision', { count: 'exact', head: true })
        .eq('command_uuid', commandUuid);
      return { row, events, receipts };
    }

    // Lumen, pr:701 9a5d87ef A1: `<>` against a NULL is NULL, and the CAS fell through.
    it.each([
      { revision: null, state: 'queued' },
      { revision: 1, state: null },
      { revision: null, state: null },
      { revision: 0, state: 'queued' },
      { revision: 1, state: 'running' },
    ])('refuses a missing or malformed expected CAS component %j, writing nothing', async (cas) => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      const { data, error } = await supabase.rpc('transition_command', {
        p_command_uuid: c.id,
        p_expected_revision: cas.revision,
        p_expected_state: cas.state,
        p_new_state: 'backend_accepted',
        p_reason_code: null,
        p_mark_started: false,
        p_executing_epoch: null,
        p_recipients: [],
        p_protocol: ADMISSION_PROTOCOL,
      });
      expect(error).toBeNull();
      expect(data).toEqual({ outcome: 'invalid', field: 'expected' });
      expect(await writes(c.id)).toEqual({
        row: { revision: 1, state: 'queued', started_at: null },
        events: 1,
        receipts: 1,
      });
    });

    it('answers missing for a command that does not exist', async () => {
      expect(
        await transitionCommand(supabase, {
          commandUuid: randomUUID(),
          expected: { revision: 1, state: 'queued' },
          to: 'backend_accepted',
        })
      ).toEqual({ outcome: 'missing' });
    });

    // Lumen, pr:701 9a5d87ef A2: the notice was keyed to one reason label, the hold is not.
    it.each([undefined, 'acceptance_unresolved', 'recovery_required'])(
      'refuses any move into unknown without an operator notice (reason %s), writing nothing',
      async (reasonCode) => {
        const sessionId = await newSession(suiteSbId);
        const c = await admitted(sessionId);
        expect(
          await transitionCommand(supabase, {
            commandUuid: c.id,
            expected: { revision: 1, state: 'queued' },
            to: 'unknown',
            reasonCode,
            recipients: [{ kind: 'sb', id: 'sb-fixture' }],
          })
        ).toEqual({ outcome: 'notice_required' });
        expect(await writes(c.id)).toEqual({
          row: { revision: 1, state: 'queued', started_at: null },
          events: 1,
          receipts: 1,
        });
        expect(await readDispatchHead(supabase, sessionId)).toEqual({
          hold: null,
          holdingCommand: null,
          head: c.id,
        });
      }
    );

    it('keeps in-flight work quiet, and lets the reconciler record a lost outcome with its notice', async () => {
      const sessionId = await newSession(suiteSbId);
      const c = await admitted(sessionId);
      // Handoff and acceptance: ordinary serialization, owed to no operator.
      await transitionCommand(supabase, {
        commandUuid: c.id,
        expected: { revision: 1, state: 'queued' },
        to: 'queued',
        markStarted: true,
      });
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 2, state: 'queued' },
          to: 'backend_accepted',
        })
      ).toEqual({ outcome: 'transitioned', revision: 3, state: 'backend_accepted' });
      expect(await readDispatchHead(supabase, sessionId)).toMatchObject({
        hold: 'unresolved_dispatch',
      });
      const { count: operatorSoFar } = await supabase
        .from('session_command_receipts')
        .select('revision', { count: 'exact', head: true })
        .eq('command_uuid', c.id)
        .eq('recipient_kind', 'operator');
      expect(operatorSoFar).toBe(0);

      // The reconciler finds the completion lost: unknown, with the notice.
      expect(
        await transitionCommand(supabase, {
          commandUuid: c.id,
          expected: { revision: 3, state: 'backend_accepted' },
          to: 'unknown',
          reasonCode: 'acceptance_unresolved',
          recipients: [{ kind: 'operator', id: 'operator-fixture' }],
        })
      ).toEqual({ outcome: 'transitioned', revision: 4, state: 'unknown' });
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: 'recovery_required',
        holdingCommand: c.id,
        head: null,
      });
      const { data: receipts } = await supabase
        .from('session_command_receipts')
        .select('recipient_kind, recipient_id')
        .eq('command_uuid', c.id)
        .eq('revision', 4)
        .order('recipient_kind');
      expect(receipts).toEqual([
        { recipient_kind: 'operator', recipient_id: 'operator-fixture' },
        { recipient_kind: 'user', recipient_id: userId },
      ]);
    });
  });

  describe('dispatch head and the unknown-effect hold', () => {
    it('names the lowest not-started command, and holds later work behind an unresolved unknown', async () => {
      const sessionId = await newSession(suiteSbId);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await admitCommand(supabase, input(sessionId));
        if (r.outcome !== 'admitted') throw new Error(`unexpected ${r.outcome}`);
        ids.push(r.id);
      }
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: null,
        holdingCommand: null,
        head: ids[0],
      });

      await transitionCommand(supabase, {
        commandUuid: ids[0],
        expected: { revision: 1, state: 'queued' },
        to: 'unknown',
        reasonCode: 'recovery_required',
        recipients: [{ kind: 'operator', id: 'operator-fixture' }],
      });
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: 'recovery_required',
        holdingCommand: ids[0],
        head: null,
      });

      // A decision lifts the hold only for the exact revision it addresses;
      // the uncertain command stays unknown either way.
      const decide = async (revision: number) => {
        const { error } = await supabase
          .from('session_commands')
          .update({
            recovery_decided_at: new Date().toISOString(),
            recovery_decided_revision: revision,
            recovery_decision: { authority: 'operator-fixture', obligations: ['fixture'] },
          })
          .eq('id', ids[0]);
        if (error) throw new Error(`decision update failed: ${error.message}`);
      };
      await decide(1);
      expect(await readDispatchHead(supabase, sessionId)).toMatchObject({
        hold: 'recovery_required',
        holdingCommand: ids[0],
      });
      await decide(2);
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: null,
        holdingCommand: null,
        head: ids[1],
      });
      // The command moving on voids the decision, and the hold comes back. That
      // write reinstates the hold, so it needs the notice like the first one,
      // whatever its reason code; refused, it writes nothing.
      expect(
        await transitionCommand(supabase, {
          commandUuid: ids[0],
          expected: { revision: 2, state: 'unknown' },
          to: 'unknown',
          reasonCode: 'acceptance_unresolved',
        })
      ).toEqual({ outcome: 'notice_required' });
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: null,
        holdingCommand: null,
        head: ids[1],
      });
      expect(
        await transitionCommand(supabase, {
          commandUuid: ids[0],
          expected: { revision: 2, state: 'unknown' },
          to: 'unknown',
          reasonCode: 'acceptance_unresolved',
          recipients: [{ kind: 'operator', id: 'operator-fixture' }],
        })
      ).toEqual({ outcome: 'transitioned', revision: 3, state: 'unknown' });
      expect(await readDispatchHead(supabase, sessionId)).toMatchObject({
        hold: 'recovery_required',
        holdingCommand: ids[0],
      });
    });

    it('holds later work behind a handoff whose status write was lost', async () => {
      const sessionId = await newSession(suiteSbId);
      const ids: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const r = await admitCommand(supabase, input(sessionId));
        if (r.outcome !== 'admitted') throw new Error(`unexpected ${r.outcome}`);
        ids.push(r.id);
      }
      // The dispatcher records the handoff, then every later write is lost.
      expect(
        await transitionCommand(supabase, {
          commandUuid: ids[0],
          expected: { revision: 1, state: 'queued' },
          to: 'queued',
          markStarted: true,
        })
      ).toEqual({ outcome: 'transitioned', revision: 2, state: 'queued' });
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: 'unresolved_dispatch',
        holdingCommand: ids[0],
        head: null,
      });
      // Accepted with its completion lost reads the same way.
      await transitionCommand(supabase, {
        commandUuid: ids[0],
        expected: { revision: 2, state: 'queued' },
        to: 'backend_accepted',
      });
      expect(await readDispatchHead(supabase, sessionId)).toMatchObject({
        hold: 'unresolved_dispatch',
        holdingCommand: ids[0],
      });
      // Only terminal evidence moves the head on.
      await transitionCommand(supabase, {
        commandUuid: ids[0],
        expected: { revision: 3, state: 'backend_accepted' },
        to: 'completed',
      });
      expect(await readDispatchHead(supabase, sessionId)).toEqual({
        hold: null,
        holdingCommand: null,
        head: ids[1],
      });
    });

    it('marks a handoff only as a same-state write on a command that has not started', async () => {
      const sessionId = await newSession(suiteSbId);
      const r = await admitCommand(supabase, input(sessionId));
      if (r.outcome !== 'admitted') throw new Error(`unexpected ${r.outcome}`);
      expect(
        await transitionCommand(supabase, {
          commandUuid: r.id,
          expected: { revision: 1, state: 'queued' },
          to: 'waiting_for_consumer',
          markStarted: true,
        })
      ).toEqual({ outcome: 'illegal_transition', from: 'queued', to: 'waiting_for_consumer' });
      await transitionCommand(supabase, {
        commandUuid: r.id,
        expected: { revision: 1, state: 'queued' },
        to: 'queued',
        markStarted: true,
      });
      expect(
        await transitionCommand(supabase, {
          commandUuid: r.id,
          expected: { revision: 2, state: 'queued' },
          to: 'queued',
          markStarted: true,
        })
      ).toEqual({ outcome: 'illegal_transition', from: 'queued', to: 'queued' });
    });

    it('does not hold another session', async () => {
      const held = await newSession(suiteSbId);
      const free = await newSession(suiteSbId);
      const h = await admitCommand(supabase, input(held));
      const f = await admitCommand(supabase, input(free));
      if (h.outcome !== 'admitted' || f.outcome !== 'admitted') throw new Error('admission failed');
      await transitionCommand(supabase, {
        commandUuid: h.id,
        expected: { revision: 1, state: 'queued' },
        to: 'unknown',
        reasonCode: 'recovery_required',
        recipients: [{ kind: 'operator', id: 'operator-fixture' }],
      });
      expect(await readDispatchHead(supabase, free)).toEqual({
        hold: null,
        holdingCommand: null,
        head: f.id,
      });
    });
  });

  describe('owner tenure and turn generations', () => {
    const HOST = { instanceId: `host-${RUN}`, bootId: 'boot-fixture-1', hostId: 'host-fixture' };

    async function register(sessionId: string, mode: TenureMode = 'interactive_wrapper') {
      const { capability, capabilityHash } = mintTenureCapability();
      const r = await registerTenure(supabase, {
        sessionId,
        expected: { kind: 'never_owned' },
        mode,
        capabilityHash,
        host: HOST,
      });
      if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
      return { tenureId: r.tenureId, capability, hostInstanceId: HOST.instanceId };
    }

    async function queued(sessionId: string): Promise<string> {
      const r = await admitCommand(supabase, input(sessionId));
      if (r.outcome !== 'admitted') throw new Error(`unexpected ${r.outcome}`);
      return r.id;
    }

    async function turn(sessionId: string, holder: TenureHolder, prior: string | null) {
      const command = await queued(sessionId);
      const epoch = randomUUID();
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: prior,
          epoch,
          commandUuid: command,
        })
      ).toEqual({ outcome: 'admitted', epoch });
      return { epoch, command };
    }

    // The claimed command, finished with terminal evidence.
    async function complete(command: string): Promise<void> {
      const { data } = await supabase
        .from('session_commands')
        .select('revision, state')
        .eq('id', command)
        .single();
      const r = await transitionCommand(supabase, {
        commandUuid: command,
        expected: { revision: data!.revision as number, state: data!.state as 'queued' },
        to: 'completed',
      });
      if (r.outcome !== 'transitioned') throw new Error(`unexpected ${r.outcome}`);
    }

    async function finish(sessionId: string, holder: TenureHolder, epoch: string) {
      expect(
        await finishTurn(supabase, { sessionId, holder, epoch, evidence: 'cli_stop' })
      ).toEqual({
        outcome: 'finished',
        epoch,
      });
    }

    async function settledSpawn(
      sessionId: string,
      holder: TenureHolder,
      epoch: string,
      invocationId: string,
      records: InvocationRecord[]
    ) {
      for (const record of [{ kind: 'intent' } as InvocationRecord, ...records]) {
        await recordInvocation(supabase, { sessionId, holder, epoch, invocationId, record });
      }
    }

    // Created while the database was legacy, so it has no admission origin;
    // `fields` are legacy writes, such as a running turn.
    async function legacySession(fields: Record<string, unknown> = {}): Promise<string> {
      await setMode('legacy');
      try {
        const sessionId = await newSession(suiteSbId);
        if (Object.keys(fields).length) {
          const { error } = await supabase.from('sessions').update(fields).eq('id', sessionId);
          if (error) throw new Error(`legacy update failed: ${error.message}`);
        }
        return sessionId;
      } finally {
        await setMode('conditional');
      }
    }

    // What a reconciler reads before it attests: the row as it stands.
    async function inspectLegacy(sessionId: string): Promise<LegacySessionState> {
      const { data, error } = await supabase
        .from('sessions')
        .select(
          'turn_epoch, backend_session_id, lifecycle, cli_turn_at, cli_turn_stopped_at, updated_at'
        )
        .eq('id', sessionId)
        .single();
      if (error || !data) throw new Error(`inspect failed: ${error?.message}`);
      return {
        turnEpoch: data.turn_epoch,
        backendSessionId: data.backend_session_id,
        lifecycle: data.lifecycle,
        cliTurnAt: data.cli_turn_at,
        cliTurnStoppedAt: data.cli_turn_stopped_at,
        updatedAt: data.updated_at,
      };
    }

    const LEGACY_PROOF = 'legacy-quiescence-attestation-fixture';

    // The default boot_changed reference: a digest over the length-prefixed
    // machine, recorded boot and current boot (ASCII fixtures, so length agrees).
    function bootRef(hostId: string, recordedBootId: string, currentBootId: string): string {
      const encoded = [hostId, recordedBootId, currentBootId]
        .map((v) => `${v.length}:${v}`)
        .join('');
      return `boot_changed:sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
    }

    function attestLegacy(
      sessionId: string,
      expectedLegacy: LegacySessionState | undefined,
      overrides: Partial<Parameters<typeof reconcileTenure>[1]> = {}
    ) {
      return reconcileTenure(supabase, {
        sessionId,
        expectedTenureId: null,
        evidence: 'legacy_quiescence_attested',
        currentHostId: HOST.hostId,
        evidenceRef: LEGACY_PROOF,
        expectedLegacy,
        authority: 'reconciler-fixture',
        hostInstanceId: HOST.instanceId,
        ...overrides,
      });
    }

    it('refuses in legacy mode', async () => {
      const sessionId = await newSession(suiteSbId);
      await setMode('legacy');
      try {
        const { capabilityHash } = mintTenureCapability();
        expect(
          await registerTenure(supabase, {
            sessionId,
            expected: { kind: 'never_owned' },
            mode: 'server_hosted',
            capabilityHash,
            host: HOST,
          })
        ).toEqual({ outcome: 'mode_mismatch', mode: 'legacy', protocol: ADMISSION_PROTOCOL });
      } finally {
        await setMode('conditional');
      }
    });

    it('takes never-owned only from evidence recorded at creation; a legacy session is occupied', async () => {
      // Created while the database was legacy: no origin, null markers or not.
      await setMode('legacy');
      let legacy: string;
      try {
        legacy = await newSession(suiteSbId);
      } finally {
        await setMode('conditional');
      }
      const { capabilityHash } = mintTenureCapability();
      expect(
        await registerTenure(supabase, {
          sessionId: legacy,
          expected: { kind: 'never_owned' },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        })
      ).toEqual({ outcome: 'unverified' });

      // A legacy turn epoch with no record of its turn reads the same way.
      const fresh = await newSession(suiteSbId);
      await supabase.from('sessions').update({ turn_epoch: randomUUID() }).eq('id', fresh);
      expect(
        await registerTenure(supabase, {
          sessionId: fresh,
          expected: { kind: 'never_owned' },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        })
      ).toEqual({ outcome: 'unverified' });

      const created = await newSession(suiteSbId);
      const holder = await register(created);
      expect(holder.tenureId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('lets only the holder act: knowing the tenure id is not enough', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const command = await queued(sessionId);
      const attempt = (h: TenureHolder) =>
        admitTurn(supabase, {
          sessionId,
          holder: h,
          expectedPriorEpoch: null,
          epoch: randomUUID(),
          commandUuid: command,
        });
      expect(await attempt({ ...holder, capability: mintTenureCapability().capability })).toEqual({
        outcome: 'not_holder',
      });
      expect(await attempt({ ...holder, hostInstanceId: 'another-host' })).toEqual({
        outcome: 'not_holder',
      });
      expect(await attempt({ ...holder, tenureId: randomUUID() })).toEqual({
        outcome: 'not_holder',
      });
      expect((await attempt(holder)).outcome).toBe('admitted');
    });

    it('serializes turns under one tenure: busy while active, then the next turn on exact CAS', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const first = await turn(sessionId, holder, null);
      const next = await queued(sessionId);
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: first.epoch,
          epoch: randomUUID(),
          commandUuid: next,
        })
      ).toEqual({ outcome: 'busy', epoch: first.epoch });
      await finish(sessionId, holder, first.epoch);
      // Finishing kept the tenure: another owner cannot register.
      const { capabilityHash } = mintTenureCapability();
      expect(
        await registerTenure(supabase, {
          sessionId,
          expected: { kind: 'never_owned' },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        })
      ).toEqual({ outcome: 'occupied', tenureId: holder.tenureId, state: 'held' });
      // The claimed command still holds until terminal evidence.
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: first.epoch,
          epoch: randomUUID(),
          commandUuid: next,
        })
      ).toMatchObject({
        outcome: 'held',
        hold: 'unresolved_dispatch',
        holdingCommand: first.command,
      });
      await complete(first.command);
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: null,
          epoch: randomUUID(),
          commandUuid: next,
        })
      ).toEqual({ outcome: 'stale_expectation', epoch: first.epoch });
      const epoch = randomUUID();
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: first.epoch,
          epoch,
          commandUuid: next,
        })
      ).toEqual({ outcome: 'admitted', epoch });
    });

    it('takes only the FIFO head', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const head = await queued(sessionId);
      const later = await queued(sessionId);
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: null,
          epoch: randomUUID(),
          commandUuid: later,
        })
      ).toEqual({ outcome: 'not_fifo_head', head });
    });

    it('holds the next turn behind an unbound spawn of a finished turn, and lets a bound one continue', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const first = await turn(sessionId, holder, null);
      await settledSpawn(sessionId, holder, first.epoch, 'inv-1', []);
      await finish(sessionId, holder, first.epoch);
      await complete(first.command);
      const next = await queued(sessionId);
      const attempt = () =>
        admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: first.epoch,
          epoch: randomUUID(),
          commandUuid: next,
        });
      expect(await attempt()).toEqual({ outcome: 'unresolved', epoch: first.epoch });
      // Bound: a tracked process of the owner's own, not unknown merely because alive.
      await recordInvocation(supabase, {
        sessionId,
        holder,
        epoch: first.epoch,
        invocationId: 'inv-1',
        record: { kind: 'process_binding', pid: 4242, startIdentity: 'start-fixture-1' },
      });
      expect((await attempt()).outcome).toBe('admitted');
    });

    it('holds the next turn behind a claimed command whose status write was lost', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const first = await turn(sessionId, holder, null);
      await finish(sessionId, holder, first.epoch);
      // No terminal write ever lands for first.command.
      const next = await queued(sessionId);
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: first.epoch,
          epoch: randomUUID(),
          commandUuid: next,
        })
      ).toMatchObject({
        outcome: 'held',
        hold: 'unresolved_dispatch',
        holdingCommand: first.command,
      });
    });

    it('releases only on resolved spawns: an empty process group is not tree quiescence', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const first = await turn(sessionId, holder, null);
      await settledSpawn(sessionId, holder, first.epoch, 'inv-1', [
        { kind: 'process_binding', pid: 4243, startIdentity: 'start-fixture-2' },
        { kind: 'parent_exited' },
        { kind: 'group_empty' },
      ]);
      await finish(sessionId, holder, first.epoch);
      await complete(first.command);
      const release = () =>
        releaseTenure(supabase, { sessionId, holder, evidence: 'wrapper_exit_tree_quiescent' });
      expect(await release()).toEqual({ outcome: 'unresolved', invocations: 1 });
      await recordInvocation(supabase, {
        sessionId,
        holder,
        epoch: first.epoch,
        invocationId: 'inv-1',
        record: { kind: 'tree_quiescent', evidenceRef: 'attestation-fixture-1' },
      });
      expect(await release()).toEqual({ outcome: 'released', tenureId: holder.tenureId });
    });

    it('refuses a retained holder after release, and admits the next owner on the exact prior', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId, 'server_hosted');
      const first = await turn(sessionId, holder, null);
      await finish(sessionId, holder, first.epoch);
      await complete(first.command);
      expect(
        await releaseTenure(supabase, { sessionId, holder, evidence: 'controller_retired' })
      ).toEqual({ outcome: 'released', tenureId: holder.tenureId });

      // The retired controller object still has its capability and tenure id.
      const next = await queued(sessionId);
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: first.epoch,
          epoch: randomUUID(),
          commandUuid: next,
        })
      ).toEqual({ outcome: 'not_holder' });
      expect(
        await recordInvocation(supabase, {
          sessionId,
          holder,
          epoch: first.epoch,
          invocationId: 'late',
          record: { kind: 'intent' },
        })
      ).toEqual({ outcome: 'not_holder' });

      const { capability, capabilityHash } = mintTenureCapability();
      const base = { sessionId, mode: 'interactive_wrapper' as const, capabilityHash, host: HOST };
      expect(
        await registerTenure(supabase, { ...base, expected: { kind: 'never_owned' } })
      ).toMatchObject({
        outcome: 'stale_expectation',
        state: 'released',
      });
      expect(
        await registerTenure(supabase, {
          ...base,
          expected: { kind: 'released', tenureId: randomUUID() },
        })
      ).toMatchObject({ outcome: 'stale_expectation', tenureId: holder.tenureId });
      const r = await registerTenure(supabase, {
        ...base,
        expected: { kind: 'released', tenureId: holder.tenureId },
      });
      if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
      const successor = { tenureId: r.tenureId, capability, hostInstanceId: HOST.instanceId };
      const epoch = randomUUID();
      expect(
        await admitTurn(supabase, {
          sessionId,
          holder: successor,
          expectedPriorEpoch: first.epoch,
          epoch,
          commandUuid: next,
        })
      ).toEqual({ outcome: 'admitted', epoch });
    });

    it('treats an identical binding retry as a no-op and a conflicting one as a contradiction only a reconciler clears', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const first = await turn(sessionId, holder, null);
      const record = (r: InvocationRecord) =>
        recordInvocation(supabase, {
          sessionId,
          holder,
          epoch: first.epoch,
          invocationId: 'inv-1',
          record: r,
        });
      expect(await record({ kind: 'intent' })).toEqual({ outcome: 'recorded', kind: 'intent' });
      expect(await record({ kind: 'intent' })).toEqual({
        outcome: 'already_recorded',
        kind: 'intent',
      });
      const binding = {
        kind: 'process_binding' as const,
        pid: 4244,
        startIdentity: 'start-fixture-3',
      };
      expect(await record(binding)).toEqual({ outcome: 'recorded', kind: 'process_binding' });
      expect(await record(binding)).toEqual({
        outcome: 'already_recorded',
        kind: 'process_binding',
      });
      expect(await record({ ...binding, pid: 4245 })).toEqual({
        outcome: 'contradiction',
        kind: 'process_binding',
      });
      // The holder's later evidence is no longer accepted for it.
      expect(
        await record({ kind: 'tree_quiescent', evidenceRef: 'attestation-fixture-2' })
      ).toEqual({
        outcome: 'contradiction',
        kind: 'tree_quiescent',
      });
      await finish(sessionId, holder, first.epoch);
      await complete(first.command);
      expect(
        await releaseTenure(supabase, {
          sessionId,
          holder,
          evidence: 'wrapper_exit_tree_quiescent',
        })
      ).toEqual({ outcome: 'unresolved', invocations: 1 });

      // Only a whole-tree verification by the reconciler clears it.
      expect(
        await reconcileTenure(supabase, {
          sessionId,
          expectedTenureId: holder.tenureId,
          evidence: 'owner_tree_gone',
          evidenceRef: 'reconciler-attestation-fixture',
          authority: 'reconciler-fixture',
          hostInstanceId: HOST.instanceId,
        })
      ).toEqual({ outcome: 'reconciled', tenureId: holder.tenureId });
      const { capabilityHash } = mintTenureCapability();
      expect(
        await registerTenure(supabase, {
          sessionId,
          expected: { kind: 'reconciled', tenureId: holder.tenureId },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        })
      ).toMatchObject({ outcome: 'registered' });
    });

    it('keeps a lost owner occupied until boot evidence the tenure itself recorded', async () => {
      const sessionId = await newSession(suiteSbId);
      const holder = await register(sessionId);
      const first = await turn(sessionId, holder, null);
      expect(
        await markTenureLost(supabase, {
          sessionId,
          tenureId: holder.tenureId,
          authority: 'reconciler-fixture',
          reasonCode: 'owner_unreachable',
        })
      ).toEqual({ outcome: 'recovery_required', tenureId: holder.tenureId });
      const { capabilityHash } = mintTenureCapability();
      expect(
        await registerTenure(supabase, {
          sessionId,
          expected: { kind: 'never_owned' },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        })
      ).toEqual({ outcome: 'occupied', tenureId: holder.tenureId, state: 'recovery_required' });
      const reconcile = (currentBootId: string) =>
        reconcileTenure(supabase, {
          sessionId,
          expectedTenureId: holder.tenureId,
          evidence: 'boot_changed',
          currentBootId,
          currentHostId: HOST.hostId,
          authority: 'reconciler-fixture',
          hostInstanceId: HOST.instanceId,
        });
      expect(await reconcile(HOST.bootId)).toEqual({
        outcome: 'refused',
        reason: 'boot_evidence_absent_or_same',
      });
      expect(await reconcile('boot-fixture-2')).toEqual({
        outcome: 'reconciled',
        tenureId: holder.tenureId,
      });
      // Process overlap is cleared; the turn's command is still unresolved and holds.
      const next = await queued(sessionId);
      const r = await registerTenure(supabase, {
        sessionId,
        expected: { kind: 'reconciled', tenureId: holder.tenureId },
        mode: 'server_hosted',
        capabilityHash,
        host: HOST,
      });
      expect(r).toMatchObject({
        outcome: 'held',
        hold: 'unresolved_dispatch',
        holdingCommand: first.command,
      });
      void next;
    });

    it('refuses boot evidence when the tenure never recorded its machine or boot', async () => {
      const sessionId = await newSession(suiteSbId);
      const { capabilityHash } = mintTenureCapability();
      const r = await registerTenure(supabase, {
        sessionId,
        expected: { kind: 'never_owned' },
        mode: 'interactive_wrapper',
        capabilityHash,
        host: { instanceId: HOST.instanceId },
      });
      if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
      expect(
        await reconcileTenure(supabase, {
          sessionId,
          expectedTenureId: r.tenureId,
          evidence: 'boot_changed',
          currentBootId: 'any-boot',
          currentHostId: HOST.hostId,
          authority: 'reconciler-fixture',
          hostInstanceId: HOST.instanceId,
        })
      ).toEqual({ outcome: 'refused', reason: 'machine_scope_absent_or_different' });
    });

    it('clears unverified history only by a legacy quiescence attestation', async () => {
      const legacy = await legacySession();
      const reconcile = (evidence: 'boot_changed' | 'owner_tree_gone') =>
        reconcileTenure(supabase, {
          sessionId: legacy,
          expectedTenureId: null,
          evidence,
          currentBootId: 'boot-fixture-9',
          currentHostId: HOST.hostId,
          evidenceRef: 'reconciler-attestation-fixture',
          authority: 'reconciler-fixture',
          hostInstanceId: HOST.instanceId,
        });
      for (const evidence of ['boot_changed', 'owner_tree_gone'] as const) {
        expect(await reconcile(evidence)).toEqual({
          outcome: 'refused',
          reason: 'unverified_history_needs_legacy_attestation',
        });
      }
      const attested = await attestLegacy(legacy, await inspectLegacy(legacy));
      if (attested.outcome !== 'reconciled') throw new Error(`unexpected ${attested.outcome}`);
      const { capabilityHash } = mintTenureCapability();
      expect(
        await registerTenure(supabase, {
          sessionId: legacy,
          expected: { kind: 'reconciled', tenureId: attested.tenureId },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        })
      ).toMatchObject({ outcome: 'registered' });
    });

    // Round 2 (Lumen 03ae1d66): each case ported from the review's probes.
    describe('review round 2', () => {
      async function boundSpawn(
        sessionId: string,
        holder: TenureHolder,
        epoch: string,
        invocationId = 'inv-1'
      ) {
        await settledSpawn(sessionId, holder, epoch, invocationId, [
          { kind: 'process_binding', pid: 4250, startIdentity: 'start-fixture-r2' },
        ]);
      }

      it('B1: holds a later turn when an older turn’s background spawn turns unknown', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const a = await turn(sessionId, holder, null);
        await boundSpawn(sessionId, holder, a.epoch);
        await finish(sessionId, holder, a.epoch);
        await complete(a.command);
        const b = await turn(sessionId, holder, a.epoch);
        await finish(sessionId, holder, b.epoch);
        await complete(b.command);
        expect(
          await recordInvocation(supabase, {
            sessionId,
            holder,
            epoch: a.epoch,
            invocationId: 'inv-1',
            record: { kind: 'unknown', reasonCode: 'containment_lost' },
          })
        ).toEqual({ outcome: 'recorded', kind: 'unknown' });
        const next = await queued(sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId,
            holder,
            expectedPriorEpoch: b.epoch,
            epoch: randomUUID(),
            commandUuid: next,
          })
        ).toEqual({ outcome: 'unresolved', epoch: b.epoch });
      });

      it('B2: a new unknown clears an earlier quiescence, and the holder cannot resolve it again', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const a = await turn(sessionId, holder, null);
        await boundSpawn(sessionId, holder, a.epoch);
        const record = (r: InvocationRecord) =>
          recordInvocation(supabase, {
            sessionId,
            holder,
            epoch: a.epoch,
            invocationId: 'inv-1',
            record: r,
          });
        await record({ kind: 'tree_quiescent', evidenceRef: 'attestation-fixture-old' });
        expect(await record({ kind: 'unknown', reasonCode: 'containment_lost' })).toEqual({
          outcome: 'recorded',
          kind: 'unknown',
        });
        expect(
          await record({ kind: 'tree_quiescent', evidenceRef: 'attestation-fixture-new' })
        ).toEqual({ outcome: 'needs_reconciler', kind: 'tree_quiescent' });
        await finish(sessionId, holder, a.epoch);
        await complete(a.command);
        expect(
          await releaseTenure(supabase, {
            sessionId,
            holder,
            evidence: 'wrapper_exit_tree_quiescent',
          })
        ).toEqual({ outcome: 'unresolved', invocations: 1 });
      });

      it.each(['transcript_first', 'refusal_first'] as const)(
        'B3: not_spawned contradicts a transcript binding (%s)',
        async (order) => {
          const sessionId = await newSession(suiteSbId);
          const holder = await register(sessionId);
          const a = await turn(sessionId, holder, null);
          const record = (r: InvocationRecord) =>
            recordInvocation(supabase, {
              sessionId,
              holder,
              epoch: a.epoch,
              invocationId: 'inv-1',
              record: r,
            });
          await record({ kind: 'intent' });
          const transcript: InvocationRecord = {
            kind: 'transcript_binding',
            providerTranscriptId: 'transcript-fixture',
          };
          const refusal: InvocationRecord = { kind: 'not_spawned', evidenceRef: 'refusal-fixture' };
          await record(order === 'transcript_first' ? transcript : refusal);
          const second = order === 'transcript_first' ? refusal : transcript;
          expect(await record(second)).toEqual({ outcome: 'contradiction', kind: second.kind });
          await finish(sessionId, holder, a.epoch);
          await complete(a.command);
          expect(
            await releaseTenure(supabase, {
              sessionId,
              holder,
              evidence: 'wrapper_exit_tree_quiescent',
            })
          ).toEqual({ outcome: 'unresolved', invocations: 1 });
        }
      );

      it('B4: an operator decision cannot retire a tenure or manufacture quiescence', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const a = await turn(sessionId, holder, null);
        await boundSpawn(sessionId, holder, a.epoch);
        await finish(sessionId, holder, a.epoch);
        await complete(a.command);
        expect(
          await reconcileTenure(supabase, {
            sessionId,
            expectedTenureId: holder.tenureId,
            evidence: 'operator_decision',
            evidenceRef: 'effect-risk-acceptance-fixture',
            authority: 'operator-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'refused', reason: 'operator_decision_cannot_prove_quiescence' });
        const { data } = await supabase
          .from('session_turn_invocations')
          .select('resolution')
          .eq('session_id', sessionId)
          .eq('epoch', a.epoch)
          .single();
        expect(data).toEqual({ resolution: null });
        const { data: tenure } = await supabase
          .from('session_owner_tenures')
          .select('state')
          .eq('id', holder.tenureId)
          .single();
        expect(tenure).toEqual({ state: 'held' });
      });

      it('B5: a reconciled legacy epoch admits its first conditional turn, naming that epoch', async () => {
        const oldEpoch = randomUUID();
        const legacy = await legacySession({ turn_epoch: oldEpoch });
        // Cleared by the process proof, bound to the state the reconciler read.
        const decided = await attestLegacy(legacy, await inspectLegacy(legacy));
        if (decided.outcome !== 'reconciled') throw new Error(`unexpected ${decided.outcome}`);
        const { capability, capabilityHash } = mintTenureCapability();
        const r = await registerTenure(supabase, {
          sessionId: legacy,
          expected: { kind: 'reconciled', tenureId: decided.tenureId },
          mode: 'interactive_wrapper',
          capabilityHash,
          host: HOST,
        });
        if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
        const holder = { tenureId: r.tenureId, capability, hostInstanceId: HOST.instanceId };
        const command = await queued(legacy);
        // The legacy epoch is kept, not cleared: a turn naming no prior is stale.
        expect(
          await admitTurn(supabase, {
            sessionId: legacy,
            holder,
            expectedPriorEpoch: null,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'stale_expectation', epoch: oldEpoch });
        expect(
          await admitTurn(supabase, {
            sessionId: legacy,
            holder,
            expectedPriorEpoch: oldEpoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toMatchObject({ outcome: 'admitted' });
      });

      it('B6: boot evidence counts only for the same recorded machine', async () => {
        const boot = async (host: { instanceId: string; hostId?: string; bootId?: string }) => {
          const sessionId = await newSession(suiteSbId);
          const r = await registerTenure(supabase, {
            sessionId,
            expected: { kind: 'never_owned' },
            mode: 'interactive_wrapper',
            capabilityHash: mintTenureCapability().capabilityHash,
            host,
          });
          if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
          return (currentHostId: string | undefined, currentBootId: string, instance: string) =>
            reconcileTenure(supabase, {
              sessionId,
              expectedTenureId: r.tenureId,
              evidence: 'boot_changed',
              currentBootId,
              currentHostId,
              authority: 'reconciler-fixture',
              hostInstanceId: instance,
            });
        };
        // A boot id with no machine id: another machine's boot proves nothing.
        const noMachine = await boot({ instanceId: HOST.instanceId, bootId: 'boot-a1' });
        expect(await noMachine('machine-b', 'boot-b1', 'other-instance')).toEqual({
          outcome: 'refused',
          reason: 'machine_scope_absent_or_different',
        });
        expect(await noMachine(undefined, 'boot-b1', 'other-instance')).toEqual({
          outcome: 'refused',
          reason: 'machine_scope_absent_or_different',
        });
        // The same machine, but no boot was recorded: there is nothing to compare.
        const noBoot = await boot({ instanceId: HOST.instanceId, hostId: 'machine-c' });
        expect(await noBoot('machine-c', 'boot-c1', HOST.instanceId)).toEqual({
          outcome: 'refused',
          reason: 'boot_evidence_absent_or_same',
        });
        // A different machine is not this machine rebooting.
        const scoped = await boot({
          instanceId: HOST.instanceId,
          hostId: 'machine-a',
          bootId: 'boot-a1',
        });
        expect(await scoped('machine-b', 'boot-b1', HOST.instanceId)).toEqual({
          outcome: 'refused',
          reason: 'machine_scope_absent_or_different',
        });
        // The same machine on a new boot, from a restarted reconciler instance.
        expect((await scoped('machine-a', 'boot-a2', 'restarted-instance')).outcome).toBe(
          'reconciled'
        );
      });
    });

    // Round 3 (Lumen 71956b3f): the legacy reconciliation boundary.
    describe('review round 3', () => {
      const RUNNING = {
        lifecycle: 'running',
        backend_session_id: 'fixture-native-session',
      };

      async function tenureProof(tenureId: string) {
        const { data, error } = await supabase
          .from('session_owner_tenures')
          .select('state, end_evidence, end_evidence_ref, end_evidence_scope')
          .eq('id', tenureId)
          .single();
        if (error || !data) throw new Error(`tenure read failed: ${error?.message}`);
        return data;
      }

      it('C1: accepting effect risk cannot make a running legacy session executable', async () => {
        const epoch = randomUUID();
        const legacy = await legacySession({ ...RUNNING, turn_epoch: epoch });
        const { capabilityHash } = mintTenureCapability();
        const registerNever = () =>
          registerTenure(supabase, {
            sessionId: legacy,
            expected: { kind: 'never_owned' },
            mode: 'interactive_wrapper',
            capabilityHash,
            host: HOST,
          });
        expect(await registerNever()).toEqual({ outcome: 'unverified' });
        expect(
          await reconcileTenure(supabase, {
            sessionId: legacy,
            expectedTenureId: null,
            evidence: 'operator_decision',
            evidenceRef: 'effect-risk-acceptance-fixture',
            authority: 'operator-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'refused', reason: 'operator_decision_cannot_prove_quiescence' });
        // Nothing was written: no tenure, no pointer, still unverified.
        const { data: tenures } = await supabase
          .from('session_owner_tenures')
          .select('id')
          .eq('session_id', legacy);
        expect(tenures).toEqual([]);
        const { data: row } = await supabase
          .from('sessions')
          .select('owner_tenure_id')
          .eq('id', legacy)
          .single();
        expect(row).toEqual({ owner_tenure_id: null });
        expect(await registerNever()).toEqual({ outcome: 'unverified' });
      });

      it('C1: a legacy attestation holds only for the exact state it inspected', async () => {
        const epoch = randomUUID();
        const legacy = await legacySession({ ...RUNNING, turn_epoch: epoch });
        const inspected = await inspectLegacy(legacy);
        expect(inspected).toMatchObject({
          turnEpoch: epoch,
          lifecycle: 'running',
          backendSessionId: 'fixture-native-session',
        });

        // The legacy process writes after the inspection: the proof is stale,
        // and the reply carries the state to inspect again.
        const { error: writeErr } = await supabase
          .from('sessions')
          .update({ context: 'invented progress note' })
          .eq('id', legacy);
        expect(writeErr).toBeNull();
        const current = await inspectLegacy(legacy);
        expect(current.updatedAt).not.toEqual(inspected.updatedAt);
        const stale = await attestLegacy(legacy, inspected);
        expect(stale).toMatchObject({ outcome: 'stale_expectation', tenureId: null });
        if (stale.outcome !== 'stale_expectation' || !stale.legacy) throw new Error('no state');
        expect(stale.legacy).toMatchObject({
          turnEpoch: epoch,
          lifecycle: 'running',
          backendSessionId: 'fixture-native-session',
        });
        expect(Date.parse(stale.legacy.updatedAt!)).toBe(Date.parse(current.updatedAt!));

        // Every field is bound: one changed field is stale, null or not.
        const changed: LegacySessionState[] = [
          { ...current, turnEpoch: randomUUID() },
          { ...current, turnEpoch: null },
          { ...current, backendSessionId: 'other-native-session' },
          { ...current, backendSessionId: null },
          { ...current, lifecycle: 'idle' },
          { ...current, cliTurnAt: '2026-01-01T00:00:00Z' },
          { ...current, cliTurnStoppedAt: '2026-01-01T00:00:00Z' },
          { ...current, updatedAt: '2026-01-01T00:00:00Z' },
          { ...current, updatedAt: null },
        ];
        for (const expectedLegacy of changed) {
          expect(await attestLegacy(legacy, expectedLegacy)).toMatchObject({
            outcome: 'stale_expectation',
          });
        }

        // The binding names every field and nothing else; an instant that does
        // not parse is invalid, never read as the null it might match.
        const { updatedAt: _omitted, ...missing } = current;
        const malformed: unknown[] = [
          missing,
          { ...current, extra: null },
          { ...current, lifecycle: 7 },
          { ...current, cliTurnAt: 'not-an-instant' },
        ];
        for (const expectedLegacy of malformed) {
          expect(await attestLegacy(legacy, expectedLegacy as LegacySessionState)).toEqual({
            outcome: 'invalid',
            field: 'expectedLegacy',
          });
        }
        expect(await attestLegacy(legacy, undefined)).toEqual({
          outcome: 'invalid',
          field: 'expectedLegacy',
        });
        expect(await attestLegacy(legacy, current, { evidenceRef: undefined })).toEqual({
          outcome: 'invalid',
          field: 'evidenceRef',
        });
        expect(await attestLegacy(legacy, current, { currentHostId: undefined })).toEqual({
          outcome: 'invalid',
          field: 'host',
        });
        // Another kind of evidence carries no legacy binding.
        expect(
          await attestLegacy(legacy, current, {
            evidence: 'owner_tree_gone',
            evidenceRef: 'reconciler-attestation-fixture',
          })
        ).toEqual({ outcome: 'invalid', field: 'expectedLegacy' });
        const { data: before } = await supabase
          .from('session_owner_tenures')
          .select('id')
          .eq('session_id', legacy);
        expect(before).toEqual([]);

        // The proof bound to the state as it stands clears the history, and
        // the next owner's first turn names the legacy epoch.
        const attested = await attestLegacy(legacy, current);
        if (attested.outcome !== 'reconciled') throw new Error(`unexpected ${attested.outcome}`);
        const { capability, capabilityHash } = mintTenureCapability();
        const r = await registerTenure(supabase, {
          sessionId: legacy,
          expected: { kind: 'reconciled', tenureId: attested.tenureId },
          mode: 'interactive_wrapper',
          capabilityHash,
          host: HOST,
        });
        if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
        const command = await queued(legacy);
        expect(
          await admitTurn(supabase, {
            sessionId: legacy,
            holder: { tenureId: r.tenureId, capability, hostInstanceId: HOST.instanceId },
            expectedPriorEpoch: epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toMatchObject({ outcome: 'admitted' });
      });

      it('C1: a legacy attestation cannot retire a registered tenure', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        expect(
          await attestLegacy(sessionId, await inspectLegacy(sessionId), {
            expectedTenureId: holder.tenureId,
          })
        ).toEqual({ outcome: 'refused', reason: 'legacy_attestation_needs_unverified_history' });
        expect((await tenureProof(holder.tenureId)).state).toBe('held');
      });

      it('C2: the reconciled tenure keeps the proof and the scope it covered', async () => {
        // Legacy: the attestation and the exact state it was bound to.
        const epoch = randomUUID();
        const legacy = await legacySession({ ...RUNNING, turn_epoch: epoch });
        const inspected = await inspectLegacy(legacy);
        const attested = await attestLegacy(legacy, inspected);
        if (attested.outcome !== 'reconciled') throw new Error(`unexpected ${attested.outcome}`);
        const legacyProof = await tenureProof(attested.tenureId);
        expect(legacyProof).toMatchObject({
          state: 'reconciled',
          end_evidence: 'legacy_quiescence_attested',
          end_evidence_ref: LEGACY_PROOF,
          end_evidence_scope: {
            reconcilerHostId: HOST.hostId,
            legacy: {
              turnEpoch: epoch,
              lifecycle: 'running',
              backendSessionId: 'fixture-native-session',
              cliTurnAt: inspected.cliTurnAt,
              cliTurnStoppedAt: inspected.cliTurnStoppedAt,
            },
          },
        });
        const scope = legacyProof.end_evidence_scope as { legacy: LegacySessionState };
        expect(Object.keys(scope).sort()).toEqual(['legacy', 'reconcilerHostId']);
        expect(Date.parse(scope.legacy.updatedAt!)).toBe(Date.parse(inspected.updatedAt!));

        // A tenure with no spawns at all still keeps its owner-tree proof.
        const quiet = await newSession(suiteSbId);
        const quietHolder = await register(quiet);
        expect(
          await reconcileTenure(supabase, {
            sessionId: quiet,
            expectedTenureId: quietHolder.tenureId,
            evidence: 'owner_tree_gone',
            currentHostId: HOST.hostId,
            evidenceRef: 'owner-tree-attestation-fixture',
            authority: 'reconciler-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'reconciled', tenureId: quietHolder.tenureId });
        expect(await tenureProof(quietHolder.tenureId)).toEqual({
          state: 'reconciled',
          end_evidence: 'owner_tree_gone',
          end_evidence_ref: 'owner-tree-attestation-fixture',
          end_evidence_scope: {
            hostId: HOST.hostId,
            ownerPid: null,
            ownerStartIdentity: null,
            reconcilerHostId: HOST.hostId,
          },
        });

        // Boot evidence keeps the machine and both boots it compared.
        const rebooted = await newSession(suiteSbId);
        const rebootedHolder = await register(rebooted);
        expect(
          await reconcileTenure(supabase, {
            sessionId: rebooted,
            expectedTenureId: rebootedHolder.tenureId,
            evidence: 'boot_changed',
            currentBootId: 'boot-fixture-2',
            currentHostId: HOST.hostId,
            authority: 'reconciler-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'reconciled', tenureId: rebootedHolder.tenureId });
        expect(await tenureProof(rebootedHolder.tenureId)).toEqual({
          state: 'reconciled',
          end_evidence: 'boot_changed',
          end_evidence_ref: bootRef(HOST.hostId, HOST.bootId, 'boot-fixture-2'),
          end_evidence_scope: {
            hostId: HOST.hostId,
            recordedBootId: HOST.bootId,
            currentBootId: 'boot-fixture-2',
          },
        });
      });

      it('C2: a reconciled tenure cannot be stored without its proof', async () => {
        const sessionId = await newSession(suiteSbId);
        const row = {
          session_id: sessionId,
          mode: 'server_hosted',
          state: 'reconciled',
          host_instance_id: HOST.instanceId,
          ended_at: new Date().toISOString(),
          end_evidence: 'owner_tree_gone',
          ended_by: 'reconciler-fixture',
        };
        for (const proof of [
          {},
          { end_evidence_ref: 'owner-tree-attestation-fixture' },
          { end_evidence_scope: { hostId: HOST.hostId } },
        ]) {
          const { error } = await supabase
            .from('session_owner_tenures')
            .insert({ ...row, ...proof });
          expect(error?.code).toBe('23514');
          expect(error?.message).toContain('session_owner_tenures_reconciled_keeps_proof');
        }
        // Control: the same row with both is accepted.
        const { error } = await supabase.from('session_owner_tenures').insert({
          ...row,
          end_evidence_ref: 'owner-tree-attestation-fixture',
          end_evidence_scope: { hostId: HOST.hostId },
        });
        expect(error).toBeNull();
      });

      it('C3: a commandless generation needs legacy coverage evidence, null included', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const commandless = (finishEvidence: string | null) =>
          supabase.from('session_turn_generations').insert({
            session_id: sessionId,
            epoch: randomUUID(),
            tenure_id: holder.tenureId,
            command_uuid: null,
            state: 'finished',
            finished_at: new Date().toISOString(),
            finish_evidence: finishEvidence,
          });
        for (const finishEvidence of [null, 'cli_stop']) {
          const { error } = await commandless(finishEvidence);
          expect(error?.code).toBe('23514');
          expect(error?.message).toContain('session_turn_generations_command_or_legacy_coverage');
        }
        // Control: the coverage row itself is accepted.
        expect((await commandless('reconciled_legacy_epoch')).error).toBeNull();
      });
    });

    // Lumen 332f2a27 (non-blocking): inputs that reach a bounded column get a
    // typed result, never a constraint or cast error.
    describe('bounded inputs', () => {
      async function tenureProof(tenureId: string) {
        const { data, error } = await supabase
          .from('session_owner_tenures')
          .select('state, end_evidence_ref, end_evidence_scope')
          .eq('id', tenureId)
          .single();
        if (error || !data) throw new Error(`tenure read failed: ${error?.message}`);
        return data;
      }

      it('reconciles boot evidence for the longest valid ids, under a bounded reference', async () => {
        const host = {
          instanceId: HOST.instanceId,
          hostId: 'h'.repeat(200),
          bootId: 'a'.repeat(200),
        };
        const currentBootId = 'b'.repeat(200);
        const sessionId = await newSession(suiteSbId);
        const { capability, capabilityHash } = mintTenureCapability();
        const r = await registerTenure(supabase, {
          sessionId,
          expected: { kind: 'never_owned' },
          mode: 'interactive_wrapper',
          capabilityHash,
          host,
        });
        if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
        const holder = { tenureId: r.tenureId, capability, hostInstanceId: HOST.instanceId };
        const a = await turn(sessionId, holder, null);
        await settledSpawn(sessionId, holder, a.epoch, 'inv-1', [
          { kind: 'process_binding', pid: 4260, startIdentity: 'start-fixture-bounded' },
        ]);
        const reconcile = (evidenceRef?: string) =>
          reconcileTenure(supabase, {
            sessionId,
            expectedTenureId: r.tenureId,
            evidence: 'boot_changed',
            currentBootId,
            currentHostId: host.hostId,
            evidenceRef,
            authority: 'reconciler-fixture',
            hostInstanceId: HOST.instanceId,
          });
        // A supplied reference is bounded for every kind, boot evidence included.
        expect(await reconcile('r'.repeat(201))).toEqual({
          outcome: 'invalid',
          field: 'evidenceRef',
        });
        expect(await tenureProof(r.tenureId)).toMatchObject({ state: 'held' });

        expect(await reconcile()).toEqual({ outcome: 'reconciled', tenureId: r.tenureId });
        const ref = bootRef(host.hostId, host.bootId, currentBootId);
        expect(ref.length).toBeLessThanOrEqual(200);
        expect(await tenureProof(r.tenureId)).toMatchObject({
          state: 'reconciled',
          end_evidence_ref: ref,
          end_evidence_scope: { hostId: host.hostId, recordedBootId: host.bootId, currentBootId },
        });
        const { data } = await supabase
          .from('session_turn_invocations')
          .select('resolution, resolution_evidence_ref')
          .eq('session_id', sessionId)
          .eq('epoch', a.epoch)
          .single();
        expect(data).toEqual({ resolution: 'tree_quiescent', resolution_evidence_ref: ref });
      });

      it('refuses an over-long machine or boot id, and a pid past the integer range, as invalid', async () => {
        const registerWith = (
          host: { instanceId: string; hostId?: string; bootId?: string },
          owner?: number
        ) =>
          newSession(suiteSbId).then((sessionId) =>
            registerTenure(supabase, {
              sessionId,
              expected: { kind: 'never_owned' },
              mode: 'interactive_wrapper',
              capabilityHash: mintTenureCapability().capabilityHash,
              host,
              owner:
                owner === undefined ? undefined : { pid: owner, startIdentity: 'start-fixture' },
            })
          );
        expect(
          await registerWith({ instanceId: HOST.instanceId, hostId: 'h'.repeat(201) })
        ).toEqual({
          outcome: 'invalid',
          field: 'host',
        });
        expect(
          await registerWith({ instanceId: HOST.instanceId, bootId: 'a'.repeat(201) })
        ).toEqual({
          outcome: 'invalid',
          field: 'host',
        });
        expect(await registerWith(HOST, 2147483648)).toEqual({
          outcome: 'invalid',
          field: 'owner',
        });
        // Control: the largest integer pid is a valid owner.
        expect(await registerWith(HOST, 2147483647)).toMatchObject({ outcome: 'registered' });

        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const a = await turn(sessionId, holder, null);
        const bind = (pid: number) =>
          recordInvocation(supabase, {
            sessionId,
            holder,
            epoch: a.epoch,
            invocationId: 'inv-1',
            record: { kind: 'process_binding', pid, startIdentity: 'start-fixture' },
          });
        await recordInvocation(supabase, {
          sessionId,
          holder,
          epoch: a.epoch,
          invocationId: 'inv-1',
          record: { kind: 'intent' },
        });
        expect(await bind(2147483648)).toEqual({ outcome: 'invalid', field: 'detail' });
        expect(await bind(2147483647)).toEqual({ outcome: 'recorded', kind: 'process_binding' });
      });
    });
  });
});

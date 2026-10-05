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
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canonicalJournalJson,
  freezeJournalEntry,
  type JournalTarget,
} from '@inklabs/shared/runtime';
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
  admitLeasedTurn,
  admitTurn,
  finishTurn,
  markTenureLost,
  mintTenureCapability,
  reconcileTenure,
  recordInvocation,
  registerTenure,
  releaseTenure,
  tenureCapabilityHash,
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

    // Slice C1 (pr:701 d51cf192, f18c275d): studio leases join admission.
    describe('leases join admission', () => {
      const studioIds: string[] = [];
      const GRANTED = '2026-10-04T00:00:00.000Z';

      afterAll(async () => {
        if (studioIds.length) await supabase.from('studios').delete().in('id', studioIds);
      });

      // A studio on its own tree; `lease` is written as the lease service would.
      async function studio(
        lease: Record<string, unknown> | null,
        owner: string = userId
      ): Promise<string> {
        const path = `/tmp/ink-c1-${RUN}-${studioIds.length}`;
        const { data, error } = await supabase
          .from('studios')
          .insert({
            user_id: owner,
            agent_id: SUITE_SB,
            repo_root: path,
            worktree_path: path,
            branch: `c1-fixture-${studioIds.length}`,
            status: 'active',
          })
          .select('id')
          .single();
        if (error || !data) throw new Error(`studio insert failed: ${error?.message}`);
        studioIds.push(data.id as string);
        if (lease) {
          const { error: leaseErr } = await supabase
            .from('studios')
            .update({ lease })
            .eq('id', data.id);
          if (leaseErr) throw new Error(`lease write failed: ${leaseErr.message}`);
        }
        return data.id as string;
      }

      function leaseFor(
        sessionId: string,
        extra: Record<string, unknown> = {}
      ): Record<string, unknown> {
        return {
          sessionId,
          threadKey: 'thread:c1-fixture',
          acquiredAt: GRANTED,
          heartbeatAt: GRANTED,
          turnEpoch: 'epoch-granted',
          ...extra,
        };
      }

      async function leases(ids: string[]) {
        const { data } = await supabase.from('studios').select('id, lease').in('id', ids);
        return Object.fromEntries((data ?? []).map((r) => [r.id as string, r.lease]));
      }

      // Everything an admission could write, for one session.
      async function snapshot(sessionId: string, ids: string[], commands: string[]) {
        const [session, generations, commandRows, leaseRows] = await Promise.all([
          supabase
            .from('sessions')
            .select('turn_epoch, lifecycle, studio_id, owner_tenure_id')
            .eq('id', sessionId)
            .single(),
          supabase
            .from('session_turn_generations')
            .select('epoch, state')
            .eq('session_id', sessionId),
          supabase.from('session_commands').select('id, state, revision').in('id', commands),
          leases(ids),
        ]);
        return {
          session: session.data,
          generations: generations.data,
          commands: commandRows.data,
          leases: leaseRows,
        };
      }

      async function leased(
        sessionId: string,
        holder: TenureHolder,
        prior: string | null,
        studioId: string
      ) {
        const command = await queued(sessionId);
        const epoch = randomUUID();
        const r = await admitLeasedTurn(supabase, {
          sessionId,
          holder,
          expectedPriorEpoch: prior,
          epoch,
          commandUuid: command,
          studioId,
        });
        return { r, epoch, command };
      }

      it('admits under the named lease and moves exactly the session’s live leases, keeping their markers', async () => {
        const sessionId = await newSession(suiteSbId);
        const other = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const marked = leaseFor(sessionId, {
          pendingRelease: { requestedAt: GRANTED, threadKey: 'thread:c1-other' },
          threadKeys: ['thread:c1-fixture', 'thread:c1-other'],
        });
        const named = await studio(marked);
        const second = await studio(leaseFor(sessionId));
        const quarantined = await studio(leaseFor(sessionId, { quarantined: true }));
        const othersLease = await studio(leaseFor(other));
        const ids = [named, second, quarantined, othersLease];
        const before = await leases(ids);

        const { r, epoch } = await leased(sessionId, holder, null, named);
        expect(r).toEqual({ outcome: 'admitted', epoch, restamped: 2 });
        const after = await leases(ids);
        for (const id of [named, second]) {
          const lease = after[id] as Record<string, unknown>;
          expect(lease.turnEpoch).toBe(epoch);
          expect(lease.heartbeatAt).not.toBe(GRANTED);
          const { turnEpoch: _t, heartbeatAt: _h, ...rest } = lease;
          const {
            turnEpoch: _bt,
            heartbeatAt: _bh,
            ...restBefore
          } = before[id] as Record<string, unknown>;
          expect(rest).toEqual(restBefore);
        }
        expect((after[named] as Record<string, unknown>).pendingRelease).toEqual(
          marked.pendingRelease
        );
        expect((after[named] as Record<string, unknown>).threadKeys).toEqual(marked.threadKeys);
        expect(after[quarantined]).toEqual(before[quarantined]);
        expect(after[othersLease]).toEqual(before[othersLease]);
      });

      it('refuses without this session’s live named lease, and writes nothing', async () => {
        const sessionId = await newSession(suiteSbId);
        const other = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const held = await studio(leaseFor(sessionId));
        const cases: Array<[string, string]> = [
          ['lease_lost', await studio(null)],
          ['lease_lost', await studio(leaseFor(other))],
          ['lease_lost', await studio(leaseFor(sessionId, { quarantined: true }))],
          ['lease_lost', randomUUID()],
          ['forbidden', await studio(leaseFor(sessionId), otherUserId!)],
        ];
        const command = await queued(sessionId);
        const ids = [held, ...cases.map(([, id]) => id)];
        const before = await snapshot(sessionId, ids, [command]);
        for (const [outcome, studioId] of cases) {
          expect(
            await admitLeasedTurn(supabase, {
              sessionId,
              holder,
              expectedPriorEpoch: null,
              epoch: randomUUID(),
              commandUuid: command,
              studioId,
            })
          ).toEqual({ outcome });
        }
        expect(await snapshot(sessionId, ids, [command])).toEqual(before);
      });

      it('returns admission refusals unchanged, and writes nothing', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const named = await studio(leaseFor(sessionId));
        const first = await turn(sessionId, holder, null);
        const behind = await queued(sessionId);
        const ids = [named];
        const before = await snapshot(sessionId, ids, [first.command, behind]);
        const attempt = (over: Partial<Parameters<typeof admitLeasedTurn>[1]>) =>
          admitLeasedTurn(supabase, {
            sessionId,
            holder,
            expectedPriorEpoch: first.epoch,
            epoch: randomUUID(),
            commandUuid: behind,
            studioId: named,
            ...over,
          });
        // The prior turn is still active: busy.
        expect(await attempt({})).toEqual({ outcome: 'busy', epoch: first.epoch });
        expect(await attempt({ expectedPriorEpoch: null })).toEqual({
          outcome: 'stale_expectation',
          epoch: first.epoch,
        });
        expect(
          await attempt({ holder: { ...holder, capability: 'not-the-holder-secret' } })
        ).toEqual({ outcome: 'not_holder' });
        expect(await snapshot(sessionId, ids, [first.command, behind])).toEqual(before);

        await setMode('legacy');
        try {
          expect(await attempt({})).toMatchObject({ outcome: 'mode_mismatch' });
        } finally {
          await setMode('conditional');
        }
        expect(await snapshot(sessionId, ids, [first.command, behind])).toEqual(before);
      });

      it('treats a retry naming its own epoch as a refusal: lost acknowledgement, wrong command, finished turn', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId);
        const named = await studio(leaseFor(sessionId));
        const first = await leased(sessionId, holder, null, named);
        expect(first.r).toMatchObject({ outcome: 'admitted', restamped: 1 });
        const otherCommand = await queued(sessionId);
        const ids = [named];
        const retry = (commandUuid: string) =>
          admitLeasedTurn(supabase, {
            sessionId,
            holder,
            expectedPriorEpoch: null,
            epoch: first.epoch,
            commandUuid,
            studioId: named,
          });
        const afterAdmit = await snapshot(sessionId, ids, [first.command, otherCommand]);
        expect(await retry(first.command)).toEqual({
          outcome: 'stale_expectation',
          epoch: first.epoch,
        });
        expect(await retry(otherCommand)).toEqual({
          outcome: 'stale_expectation',
          epoch: first.epoch,
        });
        expect(await snapshot(sessionId, ids, [first.command, otherCommand])).toEqual(afterAdmit);

        await finish(sessionId, holder, first.epoch);
        const afterFinish = await snapshot(sessionId, ids, [first.command, otherCommand]);
        expect(await retry(first.command)).toEqual({
          outcome: 'stale_expectation',
          epoch: first.epoch,
        });
        expect(await snapshot(sessionId, ids, [first.command, otherCommand])).toEqual(afterFinish);
      });

      // Interleavings over direct connections, so a transaction can hold a
      // lock while an admission waits on it. Every client is closed, and every
      // open transaction rolled back, on every path.
      describe('interleavings', () => {
        const clients: Client[] = [];

        afterAll(async () => {
          for (const c of clients) await c.end().catch(() => undefined);
        });

        async function connect(): Promise<{ client: Client; pid: number }> {
          const url = process.env.INTEGRATION_DB_URL;
          if (!url) throw new Error('INTEGRATION_DB_URL is required (managed harness)');
          const client = new Client({ connectionString: url, statement_timeout: 15_000 });
          await client.connect();
          clients.push(client);
          const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
          return { client, pid: rows[0].pid as number };
        }

        function admitSql(
          client: Client,
          a: {
            sessionId: string;
            holder: TenureHolder;
            prior: string | null;
            epoch: string;
            command: string;
            studioId: string;
          }
        ): Promise<Record<string, unknown>> {
          return client
            .query('SELECT public.admit_leased_turn($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r', [
              a.sessionId,
              a.holder.tenureId,
              tenureCapabilityHash(a.holder.capability),
              a.holder.hostInstanceId,
              a.prior,
              a.epoch,
              a.command,
              a.studioId,
              ADMISSION_PROTOCOL,
            ])
            .then((res) => res.rows[0].r as Record<string, unknown>);
        }

        // Bounded: resolves once every pid is waiting on a lock, else throws.
        async function waitingOnLocks(observer: Client, pids: number[]): Promise<void> {
          for (let i = 0; i < 100; i += 1) {
            const { rows } = await observer.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ANY($1) AND wait_event_type = 'Lock'",
              [pids]
            );
            if (rows[0].n === pids.length) return;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error(`not all of ${pids.join(',')} reached a lock wait`);
        }

        // Whether a row can be locked right now, without waiting.
        async function lockableNow(observer: Client, table: string, id: string): Promise<boolean> {
          await observer.query('BEGIN');
          try {
            await observer.query(`SELECT 1 FROM public.${table} WHERE id = $1 FOR UPDATE NOWAIT`, [
              id,
            ]);
            return true;
          } catch (error) {
            if ((error as { code?: string }).code === '55P03') return false;
            throw error;
          } finally {
            await observer.query('ROLLBACK');
          }
        }

        // Lumen 16643e65 (C1-R1), ported from the review's probes.
        it('serializes same-path replacement before locking and restamps the actual replacement row', async () => {
          const sessionId = await newSession(suiteSbId);
          const holder = await register(sessionId);
          const named = await studio(leaseFor(sessionId));
          const command = await queued(sessionId);
          const holderTx = await connect();
          const a = await connect();
          const observer = await connect();
          let pending: Promise<Record<string, unknown>> | undefined;
          await holderTx.client.query('BEGIN');
          try {
            // The production INSERT trigger takes this same path lock. A
            // replacing writer must take it before locking/deleting the row.
            const {
              rows: [location],
            } = await holderTx.client.query(
              'SELECT user_id, public.normalize_worktree_path(worktree_path) AS path FROM public.studios WHERE id = $1',
              [named]
            );
            await holderTx.client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
              `studio-path:${location.user_id}:${location.path}`,
            ]);
            const {
              rows: [old],
            } = await holderTx.client.query(
              'SELECT * FROM public.studios WHERE id = $1 FOR UPDATE',
              [named]
            );
            pending = admitSql(a.client, {
              sessionId,
              holder,
              prior: null,
              epoch: randomUUID(),
              command,
              studioId: named,
            });
            // Ensure errors are observed even when a setup assertion fails.
            void pending.catch(() => undefined);
            await waitingOnLocks(observer.client, [a.pid]);
            await holderTx.client.query('DELETE FROM public.studios WHERE id = $1', [named]);
            await holderTx.client.query(
              `INSERT INTO public.studios
                (id, user_id, agent_id, repo_root, worktree_path, branch, status, lease)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                old.id,
                old.user_id,
                old.agent_id,
                old.repo_root,
                old.worktree_path,
                old.branch,
                old.status,
                JSON.stringify(old.lease),
              ]
            );
            await holderTx.client.query('COMMIT');
            const outcome = await pending;
            expect(outcome).toMatchObject({ outcome: 'admitted', restamped: 1 });
            const after = await leases([named]);
            expect((after[named] as Record<string, unknown>).turnEpoch).toBe(outcome.epoch);
            const admitted = await snapshot(sessionId, [], [command]);
            expect(admitted.session?.turn_epoch).toBe(outcome.epoch);
            expect(admitted.generations).toHaveLength(1);
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
            if (pending) await pending.catch(() => undefined);
          }
        });

        it('refuses an unlocked replacement after unleased insertion and direct lease assignment', async () => {
          const sessionId = await newSession(suiteSbId);
          const holder = await register(sessionId);
          const named = await studio(leaseFor(sessionId));
          const command = await queued(sessionId);
          const before = await snapshot(sessionId, [], [command]);
          const holderTx = await connect();
          const a = await connect();
          const observer = await connect();
          let pending: Promise<Record<string, unknown>> | undefined;
          await holderTx.client.query('BEGIN');
          try {
            const {
              rows: [old],
            } = await holderTx.client.query(
              'SELECT * FROM public.studios WHERE id = $1 FOR UPDATE',
              [named]
            );
            pending = admitSql(a.client, {
              sessionId,
              holder,
              prior: null,
              epoch: randomUUID(),
              command,
              studioId: named,
            });
            // Ensure errors are observed even when a setup assertion fails.
            void pending.catch(() => undefined);
            await waitingOnLocks(observer.client, [a.pid]);
            await holderTx.client.query('DELETE FROM public.studios WHERE id = $1', [named]);
            await holderTx.client.query(
              `INSERT INTO public.studios
                (id, user_id, agent_id, repo_root, worktree_path, branch, status, lease)
               VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)`,
              [
                old.id,
                old.user_id,
                old.agent_id,
                old.repo_root,
                old.worktree_path,
                old.branch,
                old.status,
              ]
            );
            // Match the fixture writer's existing unleased-insert then
            // lease-assignment shape, without a preleased INSERT trigger.
            await holderTx.client.query('UPDATE public.studios SET lease = $2 WHERE id = $1', [
              named,
              JSON.stringify(old.lease),
            ]);
            await holderTx.client.query('COMMIT');
            const outcome = await pending;
            expect(outcome).toEqual({ outcome: 'lease_lost' });
            expect(await snapshot(sessionId, [], [command])).toEqual(before);
            const after = await leases([named]);
            expect((after[named] as Record<string, unknown>).turnEpoch).toBe('epoch-granted');
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
            if (pending) await pending.catch(() => undefined);
          }
        });

        it('locks the whole studio set in one order: admissions naming different studios cannot deadlock', async () => {
          const sessionId = await newSession(suiteSbId);
          const holder = await register(sessionId);
          const pair = [
            await studio(leaseFor(sessionId)),
            await studio(leaseFor(sessionId)),
          ].sort();
          const [low, high] = pair;
          const command = await queued(sessionId);
          const holderTx = await connect();
          const a = await connect();
          const b = await connect();
          const observer = await connect();
          await holderTx.client.query('BEGIN');
          try {
            await holderTx.client.query('SELECT 1 FROM public.studios WHERE id = $1 FOR UPDATE', [
              low,
            ]);
            const settled = Promise.allSettled([
              admitSql(a.client, {
                sessionId,
                holder,
                prior: null,
                epoch: randomUUID(),
                command,
                studioId: low,
              }),
              admitSql(b.client, {
                sessionId,
                holder,
                prior: null,
                epoch: randomUUID(),
                command,
                studioId: high,
              }),
            ]);
            await waitingOnLocks(observer.client, [a.pid, b.pid]);
            // Both wait on the lower row: neither holds the higher studio row
            // ahead of it, and neither has reached the session row.
            expect(await lockableNow(observer.client, 'studios', high)).toBe(true);
            expect(await lockableNow(observer.client, 'sessions', sessionId)).toBe(true);
            await holderTx.client.query('COMMIT');
            const results = await settled;
            const outcomes = results.map((r) => {
              if (r.status === 'rejected') throw r.reason;
              return r.value;
            });
            const winner = outcomes.find((o) => o.outcome === 'admitted');
            expect(outcomes.filter((o) => o.outcome === 'admitted')).toHaveLength(1);
            expect(winner?.restamped).toBe(2);
            expect(outcomes.find((o) => o !== winner)).toEqual({
              outcome: 'stale_expectation',
              epoch: winner?.epoch,
            });
            const after = await leases([low, high]);
            expect((after[low] as Record<string, unknown>).turnEpoch).toBe(winner?.epoch);
            expect((after[high] as Record<string, unknown>).turnEpoch).toBe(winner?.epoch);
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
          }
        });

        it.each(['reassigned', 'released'] as const)(
          'refuses when the named lease is %s while the admission waits, and writes nothing',
          async (change) => {
            const sessionId = await newSession(suiteSbId);
            const other = await newSession(suiteSbId);
            const holder = await register(sessionId);
            const named = await studio(leaseFor(sessionId));
            const command = await queued(sessionId);
            const before = await snapshot(sessionId, [], [command]);
            const holderTx = await connect();
            const a = await connect();
            const observer = await connect();
            await holderTx.client.query('BEGIN');
            try {
              await holderTx.client.query('SELECT 1 FROM public.studios WHERE id = $1 FOR UPDATE', [
                named,
              ]);
              const pending = admitSql(a.client, {
                sessionId,
                holder,
                prior: null,
                epoch: randomUUID(),
                command,
                studioId: named,
              });
              await waitingOnLocks(observer.client, [a.pid]);
              const replacement = change === 'reassigned' ? JSON.stringify(leaseFor(other)) : null;
              await holderTx.client.query('UPDATE public.studios SET lease = $2 WHERE id = $1', [
                named,
                replacement,
              ]);
              await holderTx.client.query('COMMIT');
              expect(await pending).toEqual({ outcome: 'lease_lost' });
              const after = await leases([named]);
              expect(after[named]).toEqual(replacement === null ? null : leaseFor(other));
            } finally {
              await holderTx.client.query('ROLLBACK').catch(() => undefined);
            }
            expect(await snapshot(sessionId, [], [command])).toEqual(before);
          }
        );

        it('revalidates every locked row under its lock: a moved named studio is lost, and a row that changed tenant is not restamped', async () => {
          const sessionId = await newSession(suiteSbId);
          const holder = await register(sessionId);
          const named = await studio(leaseFor(sessionId));
          const second = await studio(leaseFor(sessionId));
          const command = await queued(sessionId);
          const holderTx = await connect();
          const a = await connect();
          const observer = await connect();
          const attempt = (epoch: string) =>
            admitSql(a.client, { sessionId, holder, prior: null, epoch, command, studioId: named });

          // The named studio's tree moves while the admission waits for it.
          await holderTx.client.query('BEGIN');
          try {
            // The tree can't move while leased, so the holder releases it,
            // moves it and leases it to the same session again, all before
            // the admission can look.
            await holderTx.client.query('UPDATE public.studios SET lease = NULL WHERE id = $1', [
              named,
            ]);
            await holderTx.client.query(
              'UPDATE public.studios SET worktree_path = $2, repo_root = $2 WHERE id = $1',
              [named, `/tmp/ink-c1-${RUN}-moved`]
            );
            await holderTx.client.query('UPDATE public.studios SET lease = $2 WHERE id = $1', [
              named,
              JSON.stringify(leaseFor(sessionId)),
            ]);
            const pending = attempt(randomUUID());
            await waitingOnLocks(observer.client, [a.pid]);
            await holderTx.client.query('COMMIT');
            expect(await pending).toEqual({ outcome: 'lease_lost' });
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
          }

          // Another locked row changes tenant while the admission waits.
          const epoch = randomUUID();
          await holderTx.client.query('BEGIN');
          try {
            await holderTx.client.query('SELECT 1 FROM public.studios WHERE id = $1 FOR UPDATE', [
              named,
            ]);
            await holderTx.client.query('UPDATE public.studios SET user_id = $2 WHERE id = $1', [
              second,
              otherUserId,
            ]);
            const pending = attempt(epoch);
            await waitingOnLocks(observer.client, [a.pid]);
            await holderTx.client.query('COMMIT');
            expect(await pending).toEqual({ outcome: 'admitted', epoch, restamped: 1 });
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
          }
          const after = await leases([named, second]);
          expect((after[named] as Record<string, unknown>).turnEpoch).toBe(epoch);
          expect((after[second] as Record<string, unknown>).turnEpoch).toBe('epoch-granted');

          // The named studio itself changes tenant while the admission waits.
          await holderTx.client.query('BEGIN');
          try {
            await holderTx.client.query('UPDATE public.studios SET user_id = $2 WHERE id = $1', [
              named,
              otherUserId,
            ]);
            const pending = attempt(randomUUID());
            await waitingOnLocks(observer.client, [a.pid]);
            await holderTx.client.query('COMMIT');
            expect(await pending).toEqual({ outcome: 'forbidden' });
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
          }

          // The session itself changes tenant while an admission waits on its
          // (still same-tenant) lease: the session lock sees it.
          const moved = await newSession(suiteSbId);
          const movedHolder = await register(moved);
          const movedStudio = await studio(leaseFor(moved));
          const movedCommand = await queued(moved);
          await holderTx.client.query('BEGIN');
          try {
            await holderTx.client.query('SELECT 1 FROM public.studios WHERE id = $1 FOR UPDATE', [
              movedStudio,
            ]);
            await holderTx.client.query('UPDATE public.sessions SET user_id = $2 WHERE id = $1', [
              moved,
              otherUserId,
            ]);
            const pending = admitSql(a.client, {
              sessionId: moved,
              holder: movedHolder,
              prior: null,
              epoch: randomUUID(),
              command: movedCommand,
              studioId: movedStudio,
            });
            await waitingOnLocks(observer.client, [a.pid]);
            await holderTx.client.query('COMMIT');
            expect(await pending).toEqual({ outcome: 'forbidden' });
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
          }
        });

        it('restamps only the rows it locked: a lease gained while it waits keeps its granted epoch', async () => {
          const sessionId = await newSession(suiteSbId);
          const holder = await register(sessionId);
          const named = await studio(leaseFor(sessionId));
          const later = await studio(null);
          const command = await queued(sessionId);
          const holderTx = await connect();
          const a = await connect();
          const observer = await connect();
          await holderTx.client.query('BEGIN');
          try {
            await holderTx.client.query('SELECT 1 FROM public.studios WHERE id = $1 FOR UPDATE', [
              named,
            ]);
            const epoch = randomUUID();
            const pending = admitSql(a.client, {
              sessionId,
              holder,
              prior: null,
              epoch,
              command,
              studioId: named,
            });
            await waitingOnLocks(observer.client, [a.pid]);
            // The session gains a lease after the admission chose its rows.
            await observer.client.query('UPDATE public.studios SET lease = $2 WHERE id = $1', [
              later,
              JSON.stringify(leaseFor(sessionId)),
            ]);
            await holderTx.client.query('COMMIT');
            expect(await pending).toEqual({ outcome: 'admitted', epoch, restamped: 1 });
            const after = await leases([named, later]);
            expect((after[named] as Record<string, unknown>).turnEpoch).toBe(epoch);
            expect((after[later] as Record<string, unknown>).turnEpoch).toBe('epoch-granted');
          } finally {
            await holderTx.client.query('ROLLBACK').catch(() => undefined);
          }
        });
      });
    });

    // Session journal, slice D1 (20261005021135): the append, its projection
    // into the invocation index, the hold, the lineage gates and the seal.
    describe('session journal (D1)', () => {
      const ENTRY_LIMIT = 262_144;
      let adminConnection: Client | undefined;

      afterAll(async () => {
        await adminConnection?.end().catch(() => undefined);
      });

      // The isolated stack's postgres connection: what a restore or an
      // administrator can do, and the census's view of the catalog.
      async function admin<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
        if (!adminConnection) {
          const url = process.env.INTEGRATION_DB_URL;
          if (!url) throw new Error('INTEGRATION_DB_URL is required (managed harness)');
          adminConnection = new Client({ connectionString: url, statement_timeout: 15_000 });
          await adminConnection.connect();
        }
        return (await adminConnection.query(text, params)).rows as T[];
      }

      interface JournalWriterState {
        sessionId: string;
        journalId: string;
        holder: TenureHolder;
        eid: number;
      }
      type Turn = { epoch: string; command: string };
      type EntryRecord = {
        type: string;
        target: JournalTarget | null;
        body: Record<string, unknown>;
      };

      async function journaledSession(): Promise<{ sessionId: string; journalId: string }> {
        const { data, error } = await supabase
          .from('sessions')
          .insert({
            user_id: userId,
            agent_id: SUITE_SB,
            sb_id: suiteSbId,
            status: 'active',
            journal_kind: 'db_v1',
          })
          .select('id')
          .single();
        if (error || !data) throw new Error(`journaled session insert failed: ${error?.message}`);
        sessionIds.push(data.id as string);
        const { data: journal } = await supabase
          .from('session_journals')
          .select('id')
          .eq('session_id', data.id)
          .single();
        if (!journal) throw new Error('journal header was not opened');
        return { sessionId: data.id as string, journalId: journal.id as string };
      }

      // A journaled session with a registered holder in its first turn.
      async function started(): Promise<{ w: JournalWriterState; t: Turn }> {
        const { sessionId, journalId } = await journaledSession();
        const holder = await register(sessionId, 'server_hosted');
        const t = await turn(sessionId, holder, null);
        return { w: { sessionId, journalId, holder, eid: 0 }, t };
      }

      function targetOf(holder: TenureHolder, t: Turn, invocationId: string | null): JournalTarget {
        return { tenureId: holder.tenureId, epoch: t.epoch, commandUuid: t.command, invocationId };
      }
      const ordinary = (target: JournalTarget | null, text = 'invented event'): EntryRecord => ({
        type: 'assistant_text',
        target,
        body: { text },
      });
      const intent = (target: JournalTarget): EntryRecord => ({
        type: 'provider_spawn_intent',
        target,
        body: {
          adapter: 'claude-code',
          hostMode: 'server_hosted',
          attemptId: null,
          deadlineAt: null,
          execution: { kind: 'known', hostId: HOST.hostId, bootId: HOST.bootId },
        },
      });
      const bound = (target: JournalTarget, pid = 4242): EntryRecord => ({
        type: 'provider_spawn_binding',
        target,
        body: {
          kind: 'process_binding',
          pid,
          startIdentity: `start-${pid}`,
          containment: { kind: 'unknown' },
        },
      });
      const observed = (
        target: JournalTarget,
        kind: string,
        ref = `evidence-${kind}`
      ): EntryRecord => ({
        type: 'provider_spawn_observation',
        target,
        body: kind === 'unknown' ? { kind, reasonCode: 'lost_track' } : { kind, evidenceRef: ref },
      });

      // The entry a host would send: built and frozen by the shared contract.
      function entryOf(w: JournalWriterState, eid: number, record: EntryRecord, holder = w.holder) {
        return freezeJournalEntry(
          {
            version: 1,
            journalId: w.journalId,
            sessionId: w.sessionId,
            writerTenureId: holder.tenureId,
            hostInstanceId: holder.hostInstanceId,
            eid,
            ts: new Date(Date.UTC(2026, 9, 5, 3, 0, 0, eid)).toISOString(),
            type: record.type,
            target: record.target,
            body: record.body,
          },
          ENTRY_LIMIT
        ).entry;
      }

      async function appendRaw(
        w: JournalWriterState,
        expected: number,
        entry: unknown,
        overrides: {
          holder?: TenureHolder;
          journalId?: string;
          sessionId?: string;
          protocol?: number;
        } = {}
      ): Promise<Record<string, unknown>> {
        const holder = overrides.holder ?? w.holder;
        const { data, error } = await supabase.rpc('append_session_journal', {
          p_session_id: overrides.sessionId ?? w.sessionId,
          p_tenure_id: holder.tenureId,
          p_capability_hash: tenureCapabilityHash(holder.capability),
          p_host_instance_id: holder.hostInstanceId,
          p_journal_id: overrides.journalId ?? w.journalId,
          p_expected_committed_eid: expected,
          p_entry: entry,
          p_protocol: overrides.protocol ?? ADMISSION_PROTOCOL,
        });
        if (error) throw new Error(`append_session_journal failed: ${error.message}`);
        return data as Record<string, unknown>;
      }

      // The next record under this writer; the cursor moves only on a commit.
      async function append(w: JournalWriterState, record: EntryRecord, holder = w.holder) {
        const entry = entryOf(w, w.eid + 1, record, holder);
        const reply = await appendRaw(w, w.eid, entry, { holder });
        if (reply.outcome === 'committed') w.eid += 1;
        return { reply, entry };
      }

      async function hold(
        w: JournalWriterState,
        reasonCode: string,
        holder = w.holder,
        journalId = w.journalId
      ) {
        const { data, error } = await supabase.rpc('hold_session_journal', {
          p_session_id: w.sessionId,
          p_tenure_id: holder.tenureId,
          p_capability_hash: tenureCapabilityHash(holder.capability),
          p_host_instance_id: holder.hostInstanceId,
          p_journal_id: journalId,
          p_reason_code: reasonCode,
          p_protocol: ADMISSION_PROTOCOL,
        });
        if (error) throw new Error(`hold_session_journal failed: ${error.message}`);
        return data as Record<string, unknown>;
      }

      async function header(journalId: string) {
        const { data, error } = await supabase
          .from('session_journals')
          .select(
            'committed_eid, committed_bytes, hold_reason, held_by_tenure_id, held_by_host_instance_id'
          )
          .eq('id', journalId)
          .single();
        if (error || !data) throw new Error(`header read failed: ${error?.message}`);
        return data;
      }

      async function storedEntries(journalId: string) {
        const { data, error } = await supabase
          .from('session_journal_entries')
          .select('eid, entry, entry_bytes, projection')
          .eq('journal_id', journalId)
          .order('eid');
        if (error) throw new Error(`entries read failed: ${error.message}`);
        return data ?? [];
      }

      async function invocationRow(sessionId: string, epoch: string, invocationId: string) {
        const { data, error } = await supabase
          .from('session_turn_invocations')
          .select('process_pid, resolution, unknown_reason, contradiction')
          .eq('session_id', sessionId)
          .eq('epoch', epoch)
          .eq('invocation_id', invocationId)
          .maybeSingle();
        if (error) throw new Error(`invocation read failed: ${error.message}`);
        return data;
      }

      // Everything a refused write must leave as it was.
      async function journalState(w: JournalWriterState) {
        return { header: await header(w.journalId), entries: await storedEntries(w.journalId) };
      }

      // A resolved spawn under the writer's turn.
      async function settled(w: JournalWriterState, t: Turn, invocationId: string) {
        const target = targetOf(w.holder, t, invocationId);
        for (const record of [intent(target), bound(target), observed(target, 'tree_quiescent')]) {
          const { reply } = await append(w, record);
          expect(reply).toMatchObject({ outcome: 'committed', projection: 'recorded' });
        }
      }

      async function nextTurn(w: JournalWriterState, prior: Turn): Promise<Turn> {
        await finish(w.sessionId, w.holder, prior.epoch);
        await complete(prior.command);
        return turn(w.sessionId, w.holder, prior.epoch);
      }

      async function registerAfter(sessionId: string, prior: string) {
        const { capability, capabilityHash } = mintTenureCapability();
        const r = await registerTenure(supabase, {
          sessionId,
          expected: { kind: 'released', tenureId: prior },
          mode: 'server_hosted',
          capabilityHash,
          host: HOST,
        });
        if (r.outcome !== 'registered') throw new Error(`unexpected ${r.outcome}`);
        return { tenureId: r.tenureId, capability, hostInstanceId: HOST.instanceId };
      }

      // T1 settled a spawn and released; T2 holds the session in its first turn.
      async function twoTenures() {
        const { w, t } = await started();
        const inv = `inv-${randomUUID()}`;
        await settled(w, t, inv);
        await finish(w.sessionId, w.holder, t.epoch);
        await complete(t.command);
        expect(
          await releaseTenure(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            evidence: 'controller_retired',
          })
        ).toEqual({ outcome: 'released', tenureId: w.holder.tenureId });
        const holder2 = await registerAfter(w.sessionId, w.holder.tenureId);
        const t2 = await turn(w.sessionId, holder2, t.epoch);
        const w2: JournalWriterState = { ...w, holder: holder2 };
        return { w1: w, t1: t, inv, w2, t2 };
      }

      it('opens a journal only in the creating INSERT, on a fresh conditional session, and fixes its kind', async () => {
        const { sessionId, journalId } = await journaledSession();
        expect(await header(journalId)).toMatchObject({
          committed_eid: 0,
          committed_bytes: 0,
          hold_reason: null,
        });

        const insert = (fields: Record<string, unknown>) =>
          supabase
            .from('sessions')
            .insert({
              user_id: userId,
              agent_id: SUITE_SB,
              sb_id: suiteSbId,
              status: 'active',
              ...fields,
            })
            .select('id');
        await setMode('legacy');
        try {
          const { error } = await insert({ journal_kind: 'db_v1' });
          expect(error?.message).toMatch(/fresh session created in conditional mode/);
        } finally {
          await setMode('conditional');
        }
        const used = await insert({
          journal_kind: 'db_v1',
          backend_session_id: `backend-${randomUUID()}`,
        });
        expect(used.error?.message).toMatch(/fresh session created in conditional mode/);
        const unknownKind = await insert({ journal_kind: 'db_v2' });
        expect(unknownKind.error?.message).toMatch(/sessions_journal_kind_known/);

        const cleared = await supabase
          .from('sessions')
          .update({ journal_kind: null })
          .eq('id', sessionId);
        expect(cleared.error?.message).toMatch(/journal_kind is fixed/);
        const legacy = await newSession(suiteSbId);
        const claimed = await supabase
          .from('sessions')
          .update({ journal_kind: 'db_v1' })
          .eq('id', legacy);
        expect(claimed.error?.message).toMatch(/journal_kind is fixed/);
        const { count } = await supabase
          .from('session_journals')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', legacy);
        expect(count).toBe(0);
        // Other writes to a journaled session are untouched.
        expect(
          (await supabase.from('sessions').update({ status: 'active' }).eq('id', sessionId)).error
        ).toBeNull();
      });

      it('commits each entry with its projection and the head in one step, echoing the exact entry', async () => {
        const { w, t } = await started();
        const inv = 'inv-happy';
        const target = targetOf(w.holder, t, inv);
        const records = [
          [ordinary(null), 'none'],
          [intent(target), 'recorded'],
          [bound(target), 'recorded'],
          [observed(target, 'tree_quiescent'), 'recorded'],
          [ordinary(targetOf(w.holder, t, null)), 'none'],
          [ordinary(targetOf(w.holder, t, inv)), 'none'],
        ] as const;
        for (const [record, projection] of records) {
          const eid = w.eid + 1;
          const { reply, entry } = await append(w, record);
          expect(reply).toEqual({ outcome: 'committed', entry, committedEid: eid, projection });
        }
        expect(await invocationRow(w.sessionId, t.epoch, inv)).toEqual({
          process_pid: 4242,
          resolution: 'tree_quiescent',
          unknown_reason: null,
          contradiction: false,
        });
        const rows = await storedEntries(w.journalId);
        expect(rows.map((r) => r.projection)).toEqual(records.map(([, p]) => p));
        const bytes = rows.reduce((sum, r) => sum + (r.entry_bytes as number), 0);
        expect(await header(w.journalId)).toMatchObject({
          committed_eid: 6,
          committed_bytes: bytes,
        });
        for (const row of rows) {
          // Never below the host's compact size, so a host bound is conservative.
          const compact = Buffer.byteLength(canonicalJournalJson(row.entry, 1_048_576));
          expect(row.entry_bytes as number).toBeGreaterThanOrEqual(compact);
        }
        const [check] = await admin<{ ok: boolean }>(
          'SELECT bool_and(entry_bytes = octet_length(entry::text)) AS ok FROM public.session_journal_entries WHERE journal_id = $1',
          [w.journalId]
        );
        expect(check.ok).toBe(true);
      });

      it('answers an exact retry from the stored entry, and refuses a different one at the same eid', async () => {
        const { w, t } = await started();
        await append(w, ordinary(null));
        const { entry: second } = await append(w, intent(targetOf(w.holder, t, 'inv-retry')));
        await append(w, ordinary(null, 'later'));
        const before = await journalState(w);

        expect(await appendRaw(w, 1, second)).toEqual({
          outcome: 'already_committed',
          entry: second,
          committedEid: 3,
          projection: 'recorded',
        });
        // Key order is immaterial to the comparison.
        const reordered = Object.fromEntries(Object.entries(second).reverse());
        expect(await appendRaw(w, 1, reordered)).toMatchObject({
          outcome: 'already_committed',
          committedEid: 3,
        });
        for (const changed of [
          { ...second, ts: '2026-10-05T03:00:01.000Z' },
          { ...second, body: { ...second.body, attemptId: 'attempt-1' } },
        ]) {
          expect(await appendRaw(w, 1, changed)).toEqual({
            outcome: 'refused',
            reasonCode: 'conflict',
          });
        }
        expect(await journalState(w)).toEqual(before);
      });

      it('refuses the same host under a new tenure retrying an earlier tenure entry', async () => {
        const { w, t } = await started();
        const { entry: first } = await append(w, ordinary(null));
        await finish(w.sessionId, w.holder, t.epoch);
        await complete(t.command);
        expect(
          await releaseTenure(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            evidence: 'controller_retired',
          })
        ).toMatchObject({ outcome: 'released' });
        const holder2 = await registerAfter(w.sessionId, w.holder.tenureId);
        expect(holder2.hostInstanceId).toBe(w.holder.hostInstanceId);

        expect(await appendRaw(w, 0, first, { holder: holder2 })).toEqual({
          outcome: 'refused',
          reasonCode: 'stale_writer',
        });
        expect(await appendRaw(w, 0, first)).toEqual({
          outcome: 'refused',
          reasonCode: 'not_holder',
        });
        const w2 = { ...w, holder: holder2 };
        const { reply } = await append(w2, ordinary(null, 'second tenure'));
        expect(reply).toMatchObject({ outcome: 'committed', committedEid: 2 });
      });

      it('refuses malformed, oversized, misaddressed and out-of-order entries, writing nothing', async () => {
        const { w, t } = await started();
        await append(w, ordinary(null));
        await append(w, intent(targetOf(w.holder, t, 'inv-known')));
        const before = await journalState(w);
        const next = entryOf(w, 3, ordinary(null)) as unknown as Record<string, unknown>;
        const refused = (reasonCode: string) => ({ outcome: 'refused', reasonCode });

        expect(await appendRaw(w, 2, next, { protocol: ADMISSION_PROTOCOL + 1 })).toEqual(
          refused('mode_mismatch')
        );
        const invalid: Array<[string, Record<string, unknown>]> = [
          ['uppercase journal id', { ...next, journalId: w.journalId.toUpperCase() }],
          ['another session id', { ...next, sessionId: randomUUID() }],
          ['another host instance', { ...next, hostInstanceId: 'host-other' }],
          ['an extra envelope key', { ...next, extra: true }],
          [
            'a missing envelope key',
            Object.fromEntries(Object.entries(next).filter(([k]) => k !== 'ts')),
          ],
          ['version 2', { ...next, version: 2 }],
          ['an eid past the expected head', { ...next, eid: 4 }],
          ['a fractional eid', { ...next, eid: 3.5 }],
          ['an impossible date', { ...next, ts: '2026-02-30T00:00:00.000Z' }],
          ['a timestamp without milliseconds', { ...next, ts: '2026-10-05T03:00:00Z' }],
          ['a reserved key in the body', { ...next, body: { eid: 1 } }],
          ['a body that is not an object', { ...next, body: [] }],
          ['an unknown spawn type', { ...next, type: 'provider_spawn_other' }],
          [
            'a spawn record with no invocation',
            {
              ...entryOf(w, 3, intent(targetOf(w.holder, t, 'inv-x'))),
              target: targetOf(w.holder, t, null),
            },
          ],
          [
            'a positive observation naming another tenure',
            {
              ...entryOf(w, 3, observed(targetOf(w.holder, t, 'inv-known'), 'tree_quiescent')),
              target: { ...targetOf(w.holder, t, 'inv-known'), tenureId: randomUUID() },
            },
          ],
          [
            'a pid outside the integer range',
            {
              ...entryOf(w, 3, bound(targetOf(w.holder, t, 'inv-known'))),
              body: {
                kind: 'process_binding',
                pid: 2_147_483_648,
                startIdentity: 's',
                containment: { kind: 'unknown' },
              },
            },
          ],
          [
            'an observation kind the contract does not name',
            {
              ...entryOf(w, 3, observed(targetOf(w.holder, t, 'inv-known'), 'tree_quiescent')),
              body: { kind: 'gone', evidenceRef: 'e' },
            },
          ],
        ];
        for (const [label, entry] of invalid) {
          expect(await appendRaw(w, 2, entry), label).toEqual(refused('invalid_entry'));
        }
        expect(await appendRaw(w, 2, { ...next, body: { text: 'x'.repeat(530_000) } })).toEqual(
          refused('entry_too_large')
        );

        const missingSession = randomUUID();
        expect(
          await appendRaw(
            w,
            2,
            { ...next, sessionId: missingSession },
            { sessionId: missingSession }
          )
        ).toEqual(refused('session_missing'));
        const { capability: wrong } = mintTenureCapability();
        expect(await appendRaw(w, 2, next, { holder: { ...w.holder, capability: wrong } })).toEqual(
          refused('not_holder')
        );
        const other = await journaledSession();
        expect(
          await appendRaw(
            w,
            2,
            { ...next, journalId: other.journalId },
            { journalId: other.journalId }
          )
        ).toEqual(refused('journal_missing'));
        expect(await appendRaw(w, 3, { ...next, eid: 4 })).toEqual(refused('head_mismatch'));

        expect(await journalState(w)).toEqual(before);
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-x')).toBeNull();
      });

      it('refuses a record its turn or the index cannot take, writing nothing', async () => {
        const { w, t } = await started();
        // Bound, so the same holder may continue past it.
        await append(w, intent(targetOf(w.holder, t, 'inv-open')));
        await append(w, bound(targetOf(w.holder, t, 'inv-open')));
        const t2 = await nextTurn(w, t);
        const before = await journalState(w);
        const stale = { outcome: 'refused', reasonCode: 'stale_target' };
        const cases: Array<[string, EntryRecord, object]> = [
          ['an ordinary event on a finished turn', ordinary(targetOf(w.holder, t, null)), stale],
          [
            'a turn named with another command',
            ordinary({ ...targetOf(w.holder, t2, null), commandUuid: t.command }),
            stale,
          ],
          [
            'an invocation the turn never opened',
            ordinary(targetOf(w.holder, t2, 'inv-none')),
            stale,
          ],
          [
            'a turn that does not exist',
            intent({ ...targetOf(w.holder, t2, 'inv-y'), epoch: randomUUID() }),
            stale,
          ],
          ['an intent on a finished turn', intent(targetOf(w.holder, t, 'inv-late')), stale],
          [
            'a binding before its intent',
            bound(targetOf(w.holder, t2, 'inv-unopened')),
            { outcome: 'refused', reasonCode: 'no_intent' },
          ],
        ];
        for (const [label, record, expected] of cases) {
          expect((await append(w, record)).reply, label).toEqual(expected);
        }
        expect(await journalState(w)).toEqual(before);
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-late')).toBeNull();
        expect(await invocationRow(w.sessionId, t2.epoch, 'inv-unopened')).toBeNull();
      });

      it('commits a capacity hold in place of an entry that does not fit, and the hold stops admission and release', async () => {
        const { w, t } = await started();
        const inv = 'inv-full';
        await settled(w, t, inv);
        const before = await header(w.journalId);
        await admin(
          'UPDATE public.session_journals SET byte_budget = committed_bytes + 8 WHERE id = $1',
          [w.journalId]
        );
        // Full budget: even a contradiction of a resolved spawn has no room.
        const late = await append(w, observed(targetOf(w.holder, t, inv), 'child_alive'));
        expect(late.reply).toEqual({ outcome: 'refused', reasonCode: 'capacity_held' });
        expect(await header(w.journalId)).toEqual({
          ...before,
          hold_reason: 'store_capacity',
          held_by_tenure_id: w.holder.tenureId,
          held_by_host_instance_id: w.holder.hostInstanceId,
        });
        expect(await invocationRow(w.sessionId, t.epoch, inv)).toMatchObject({
          resolution: 'tree_quiescent',
        });
        expect((await append(w, ordinary(null))).reply).toEqual({
          outcome: 'refused',
          reasonCode: 'journal_held',
        });
        // An exact retry still answers.
        const [first] = await storedEntries(w.journalId);
        expect(await appendRaw(w, 0, first.entry)).toMatchObject({
          outcome: 'already_committed',
          committedEid: 3,
        });

        await finish(w.sessionId, w.holder, t.epoch);
        await complete(t.command);
        const command = await queued(w.sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            expectedPriorEpoch: t.epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'journal_held', reasonCode: 'store_capacity' });
        expect(
          await releaseTenure(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            evidence: 'controller_retired',
          })
        ).toEqual({ outcome: 'journal_held', reasonCode: 'store_capacity' });
      });

      it('holds set-only under the same authority, echoing the reason asked for', async () => {
        const { w } = await started();
        const echo = (reasonCode: string) => ({
          outcome: 'held',
          journalId: w.journalId,
          sessionId: w.sessionId,
          writerTenureId: w.holder.tenureId,
          hostInstanceId: w.holder.hostInstanceId,
          reasonCode,
        });
        const { capability: wrong } = mintTenureCapability();
        expect(await hold(w, 'append_failed', { ...w.holder, capability: wrong })).toEqual({
          outcome: 'refused',
          reasonCode: 'not_holder',
        });
        expect(await hold(w, 'append_failed', w.holder, randomUUID())).toEqual({
          outcome: 'refused',
          reasonCode: 'journal_missing',
        });
        for (const reason of ['store_capacity', 'not_a_reason']) {
          expect(await hold(w, reason)).toEqual({
            outcome: 'refused',
            reasonCode: 'invalid_reason',
          });
        }
        expect((await header(w.journalId)).hold_reason).toBeNull();

        expect(await hold(w, 'append_failed')).toEqual(echo('append_failed'));
        expect(await hold(w, 'store_refused')).toEqual(echo('store_refused'));
        expect(await header(w.journalId)).toMatchObject({
          hold_reason: 'append_failed',
          held_by_tenure_id: w.holder.tenureId,
        });
        expect((await append(w, ordinary(null))).reply).toEqual({
          outcome: 'refused',
          reasonCode: 'journal_held',
        });
      });

      it('lets negative evidence from the current holder reopen a finished turn of its own tenure', async () => {
        const { w, t } = await started();
        const inv = 'inv-own';
        await settled(w, t, inv);
        const t2 = await nextTurn(w, t);
        const { reply } = await append(w, observed(targetOf(w.holder, t, inv), 'child_alive'));
        expect(reply).toMatchObject({ outcome: 'committed', projection: 'contradiction' });
        expect(await invocationRow(w.sessionId, t.epoch, inv)).toMatchObject({
          resolution: null,
          contradiction: true,
        });
        await finish(w.sessionId, w.holder, t2.epoch);
        await complete(t2.command);
        const command = await queued(w.sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            expectedPriorEpoch: t2.epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'unresolved', epoch: t2.epoch });
      });

      it('lets a later holder contradict an earlier tenure resolved spawn, and holds every way out', async () => {
        const { w1, t1, inv, w2, t2 } = await twoTenures();
        const { reply } = await append(w2, observed(targetOf(w1.holder, t1, inv), 'child_alive'));
        expect(reply).toMatchObject({ outcome: 'committed', projection: 'contradiction' });
        expect(await invocationRow(w2.sessionId, t1.epoch, inv)).toMatchObject({
          resolution: null,
          contradiction: true,
        });

        await finish(w2.sessionId, w2.holder, t2.epoch);
        await complete(t2.command);
        expect(
          await releaseTenure(supabase, {
            sessionId: w2.sessionId,
            holder: w2.holder,
            evidence: 'controller_retired',
          })
        ).toEqual({ outcome: 'unresolved', invocations: 1 });
        const command = await queued(w2.sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId: w2.sessionId,
            holder: w2.holder,
            expectedPriorEpoch: t2.epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'unresolved', epoch: t2.epoch });
        expect(
          await markTenureLost(supabase, {
            sessionId: w2.sessionId,
            tenureId: w2.holder.tenureId,
            authority: 'operator-fixture',
            reasonCode: 'owner_gone',
          })
        ).toEqual({ outcome: 'recovery_required', tenureId: w2.holder.tenureId });
        expect(
          await reconcileTenure(supabase, {
            sessionId: w2.sessionId,
            expectedTenureId: w2.holder.tenureId,
            evidence: 'owner_tree_gone',
            evidenceRef: 'owner-tree-fixture',
            currentHostId: HOST.hostId,
            authority: 'reconciler-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'refused', reason: 'journal_lineage_needs_journal_reconciler' });
        const { capabilityHash } = mintTenureCapability();
        expect(
          await registerTenure(supabase, {
            sessionId: w2.sessionId,
            expected: { kind: 'released', tenureId: w2.holder.tenureId },
            mode: 'server_hosted',
            capabilityHash,
            host: HOST,
          })
        ).toMatchObject({ outcome: 'occupied', state: 'recovery_required' });
        expect(await invocationRow(w2.sessionId, t1.epoch, inv)).toMatchObject({
          resolution: null,
        });
      });

      it('lets a later holder mark an earlier spawn unknown, and never resolve or bind one', async () => {
        const { w1, t1, inv, w2, t2 } = await twoTenures();
        const earlier = targetOf(w1.holder, t1, inv);
        const before = await journalState(w2);

        // Positive records stay on the writer's own turns, however they name the target.
        const positive = {
          ...entryOf(
            w2,
            w2.eid + 1,
            observed({ ...earlier, tenureId: w2.holder.tenureId }, 'tree_quiescent')
          ),
          target: earlier,
        };
        expect(await appendRaw(w2, w2.eid, positive)).toEqual({
          outcome: 'refused',
          reasonCode: 'invalid_entry',
        });
        for (const record of [
          observed({ ...earlier, tenureId: w2.holder.tenureId }, 'tree_quiescent'),
          bound({ ...earlier, tenureId: w2.holder.tenureId }),
        ]) {
          expect((await append(w2, record)).reply).toEqual({
            outcome: 'refused',
            reasonCode: 'stale_target',
          });
        }
        expect(await journalState(w2)).toEqual(before);
        expect(await invocationRow(w2.sessionId, t1.epoch, inv)).toMatchObject({
          resolution: 'tree_quiescent',
        });

        const { reply } = await append(w2, observed(earlier, 'unknown'));
        expect(reply).toMatchObject({ outcome: 'committed', projection: 'recorded' });
        expect(await invocationRow(w2.sessionId, t1.epoch, inv)).toMatchObject({
          resolution: null,
          unknown_reason: 'lost_track',
        });
        await finish(w2.sessionId, w2.holder, t2.epoch);
        await complete(t2.command);
        const command = await queued(w2.sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId: w2.sessionId,
            holder: w2.holder,
            expectedPriorEpoch: t2.epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'unresolved', epoch: t2.epoch });
      });

      it('keeps a live child of an open spawn open until quiescence, and an explicit contradiction for good', async () => {
        const { w, t } = await started();
        const a = targetOf(w.holder, t, 'inv-alive');
        await append(w, intent(a));
        await append(w, bound(a));
        expect((await append(w, observed(a, 'child_alive'))).reply).toMatchObject({
          projection: 'recorded',
        });
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-alive')).toMatchObject({
          resolution: null,
          contradiction: false,
        });
        expect((await append(w, observed(a, 'tree_quiescent'))).reply).toMatchObject({
          projection: 'recorded',
        });
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-alive')).toMatchObject({
          resolution: 'tree_quiescent',
        });

        const b = targetOf(w.holder, t, 'inv-contradicted');
        await append(w, intent(b));
        expect((await append(w, observed(b, 'contradiction'))).reply).toMatchObject({
          projection: 'contradiction',
        });
        expect((await append(w, observed(b, 'tree_quiescent'))).reply).toMatchObject({
          projection: 'contradiction',
        });
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-contradicted')).toMatchObject({
          resolution: null,
          contradiction: true,
        });
      });

      it('refuses the legacy record and reconcile paths on a DB lineage; losing the tenure only removes authority', async () => {
        const { w, t } = await started();
        await append(w, intent(targetOf(w.holder, t, 'inv-legacy')));
        expect(
          await recordInvocation(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            epoch: t.epoch,
            invocationId: 'inv-legacy',
            record: { kind: 'tree_quiescent', evidenceRef: 'legacy-path' },
          })
        ).toEqual({ outcome: 'journal_lineage' });
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-legacy')).toMatchObject({
          resolution: null,
        });
        expect(
          await markTenureLost(supabase, {
            sessionId: w.sessionId,
            tenureId: w.holder.tenureId,
            authority: 'operator-fixture',
            reasonCode: 'owner_gone',
          })
        ).toEqual({ outcome: 'recovery_required', tenureId: w.holder.tenureId });
        expect(
          await reconcileTenure(supabase, {
            sessionId: w.sessionId,
            expectedTenureId: w.holder.tenureId,
            evidence: 'owner_tree_gone',
            evidenceRef: 'owner-tree-fixture',
            currentHostId: HOST.hostId,
            authority: 'reconciler-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'refused', reason: 'journal_lineage_needs_journal_reconciler' });
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-legacy')).toMatchObject({
          resolution: null,
        });
        expect((await append(w, ordinary(null))).reply).toEqual({
          outcome: 'refused',
          reasonCode: 'not_holder',
        });
      });

      it('fails closed when an administrator removes the header under a db_v1 kind', async () => {
        const { w, t } = await started();
        await append(w, intent(targetOf(w.holder, t, 'inv-damaged')));
        await admin('DELETE FROM public.session_journals WHERE id = $1', [w.journalId]);

        expect((await append(w, ordinary(null))).reply).toEqual({
          outcome: 'refused',
          reasonCode: 'journal_missing',
        });
        expect(await hold(w, 'append_failed')).toEqual({
          outcome: 'refused',
          reasonCode: 'journal_missing',
        });
        expect(
          await recordInvocation(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            epoch: t.epoch,
            invocationId: 'inv-damaged',
            record: { kind: 'tree_quiescent', evidenceRef: 'legacy-path' },
          })
        ).toEqual({ outcome: 'journal_lineage' });
        await finish(w.sessionId, w.holder, t.epoch);
        await complete(t.command);
        const command = await queued(w.sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            expectedPriorEpoch: t.epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'journal_missing' });
        expect(
          await releaseTenure(supabase, {
            sessionId: w.sessionId,
            holder: w.holder,
            evidence: 'controller_retired',
          })
        ).toEqual({ outcome: 'journal_missing' });
        await markTenureLost(supabase, {
          sessionId: w.sessionId,
          tenureId: w.holder.tenureId,
          authority: 'operator-fixture',
          reasonCode: 'owner_gone',
        });
        expect(
          await reconcileTenure(supabase, {
            sessionId: w.sessionId,
            expectedTenureId: w.holder.tenureId,
            evidence: 'owner_tree_gone',
            evidenceRef: 'owner-tree-fixture',
            currentHostId: HOST.hostId,
            authority: 'reconciler-fixture',
            hostInstanceId: HOST.instanceId,
          })
        ).toEqual({ outcome: 'refused', reason: 'journal_lineage_needs_journal_reconciler' });
        const { capabilityHash } = mintTenureCapability();
        expect(
          await registerTenure(supabase, {
            sessionId: w.sessionId,
            expected: { kind: 'released', tenureId: w.holder.tenureId },
            mode: 'server_hosted',
            capabilityHash,
            host: HOST,
          })
        ).toEqual({ outcome: 'journal_missing' });
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-damaged')).toMatchObject({
          resolution: null,
        });
      });

      it('fails closed when an administrator adds a header to a session of no kind', async () => {
        const sessionId = await newSession(suiteSbId);
        const holder = await register(sessionId, 'server_hosted');
        const t = await turn(sessionId, holder, null);
        await settledSpawn(sessionId, holder, t.epoch, 'inv-plain', [
          { kind: 'process_binding', pid: 77, startIdentity: 'start-77' },
        ]);
        const [planted] = await admin<{ id: string }>(
          "INSERT INTO public.session_journals (session_id, kind) VALUES ($1, 'db_v1') RETURNING id",
          [sessionId]
        );
        expect(
          await recordInvocation(supabase, {
            sessionId,
            holder,
            epoch: t.epoch,
            invocationId: 'inv-plain',
            record: { kind: 'tree_quiescent', evidenceRef: 'legacy-path' },
          })
        ).toEqual({ outcome: 'journal_lineage' });
        const w: JournalWriterState = { sessionId, journalId: planted.id, holder, eid: 0 };
        expect((await append(w, ordinary(null))).reply).toEqual({
          outcome: 'refused',
          reasonCode: 'journal_missing',
        });
        await finish(sessionId, holder, t.epoch);
        await complete(t.command);
        const command = await queued(sessionId);
        expect(
          await admitTurn(supabase, {
            sessionId,
            holder,
            expectedPriorEpoch: t.epoch,
            epoch: randomUUID(),
            commandUuid: command,
          })
        ).toEqual({ outcome: 'journal_missing' });
        expect(await invocationRow(sessionId, t.epoch, 'inv-plain')).toMatchObject({
          resolution: null,
        });
      });

      it('derives entry_bytes from the row, so no write can make it disagree', async () => {
        const { w } = await started();
        await append(w, ordinary(null));
        const drift = (sql: string) =>
          admin(sql, [w.journalId]).then(
            () => 'stored',
            (error: { code?: string }) => error.code
          );
        // 428C9: a generated column cannot be written.
        expect(
          await drift(
            'UPDATE public.session_journal_entries SET entry_bytes = 3 WHERE journal_id = $1'
          )
        ).toBe('428C9');
        expect(
          await drift(
            `INSERT INTO public.session_journal_entries (journal_id, eid, entry, entry_bytes, projection)
             SELECT journal_id, 2, jsonb_set(entry, '{eid}', '2'), 3, 'none'
               FROM public.session_journal_entries WHERE journal_id = $1 AND eid = 1`
          )
        ).toBe('428C9');
        await admin(
          `UPDATE public.session_journal_entries SET entry = jsonb_set(entry, '{body,text}', to_jsonb(repeat('y', 4000)))
            WHERE journal_id = $1`,
          [w.journalId]
        );
        const [row] = await admin<{ ok: boolean }>(
          'SELECT entry_bytes = octet_length(entry::text) AND entry_bytes > 4000 AS ok FROM public.session_journal_entries WHERE journal_id = $1',
          [w.journalId]
        );
        expect(row.ok).toBe(true);
      });

      it('serializes concurrent appends at one eid: one commits, a copy is a retry, a rival conflicts', async () => {
        const { w } = await started();
        const one = entryOf(w, 1, ordinary(null, 'one'));
        const rival = entryOf(w, 1, ordinary(null, 'rival'));
        const replies = await Promise.all([
          appendRaw(w, 0, one),
          appendRaw(w, 0, one),
          appendRaw(w, 0, rival),
        ]);
        const outcomes = replies
          .map((r) => (r.outcome === 'refused' ? r.reasonCode : r.outcome))
          .sort();
        // Whichever commits first, the other two are a retry and a conflict.
        expect(outcomes.filter((o) => o === 'committed')).toHaveLength(1);
        expect(outcomes).toEqual(
          outcomes.includes('already_committed')
            ? ['already_committed', 'committed', 'conflict']
            : ['committed', 'conflict', 'conflict']
        );
        expect(await header(w.journalId)).toMatchObject({ committed_eid: 1 });
        expect(await storedEntries(w.journalId)).toHaveLength(1);
      });

      it('counts every tenure spawns when a DB lineage registers or releases', async () => {
        // Release: T2 holds no turn of its own, but T1's spawn is open again.
        const a = await twoTenures();
        await finish(a.w2.sessionId, a.w2.holder, a.t2.epoch);
        await complete(a.t2.command);
        await admin(
          `UPDATE public.session_turn_invocations SET resolution = NULL, resolution_evidence_ref = NULL, contradiction = true
            WHERE session_id = $1 AND epoch = $2`,
          [a.w2.sessionId, a.t1.epoch]
        );
        expect(
          await releaseTenure(supabase, {
            sessionId: a.w2.sessionId,
            holder: a.w2.holder,
            evidence: 'controller_retired',
          })
        ).toEqual({ outcome: 'unresolved', invocations: 1 });

        // Registration: T3 follows a clean T2, and T1's spawn reopened after T2 left.
        const b = await twoTenures();
        await finish(b.w2.sessionId, b.w2.holder, b.t2.epoch);
        await complete(b.t2.command);
        expect(
          await releaseTenure(supabase, {
            sessionId: b.w2.sessionId,
            holder: b.w2.holder,
            evidence: 'controller_retired',
          })
        ).toMatchObject({ outcome: 'released' });
        await admin(
          `UPDATE public.session_turn_invocations SET resolution = NULL, resolution_evidence_ref = NULL, contradiction = true
            WHERE session_id = $1 AND epoch = $2`,
          [b.w2.sessionId, b.t1.epoch]
        );
        const { capabilityHash } = mintTenureCapability();
        expect(
          await registerTenure(supabase, {
            sessionId: b.w2.sessionId,
            expected: { kind: 'released', tenureId: b.w2.holder.tenureId },
            mode: 'server_hosted',
            capabilityHash,
            host: HOST,
          })
        ).toEqual({ outcome: 'unresolved', tenureId: b.w2.holder.tenureId });
      });

      it('lets the reducer project a DB lineage only from the canonical entry at the head', async () => {
        const { w, t } = await started();
        await append(w, intent(targetOf(w.holder, t, 'inv-guard')));
        const client = new Client({
          connectionString: process.env.INTEGRATION_DB_URL,
          statement_timeout: 15_000,
        });
        await client.connect();
        try {
          const attempt = async (journalId: string | null, eid: number | null) => {
            await client.query('BEGIN');
            try {
              await client.query('SET LOCAL ROLE ink_admission_writer');
              await client.query(
                `SELECT ink_admission.reduce_invocation($1, $2, $3, 'inv-guard', 'tree_quiescent',
                   '{"evidenceRef":"forged"}'::jsonb, $4, $5)`,
                [w.sessionId, w.holder.tenureId, t.epoch, journalId, eid]
              );
              return 'projected';
            } catch (error) {
              return (error as { code?: string }).code;
            } finally {
              await client.query('ROLLBACK');
            }
          };
          expect(await attempt(null, null)).toBe('IJ002');
          // The committed intent is not the head+1 entry, and says something else.
          expect(await attempt(w.journalId, 1)).toBe('IJ002');
          expect(await attempt(w.journalId, 2)).toBe('IJ002');
        } finally {
          await client.end();
        }
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-guard')).toMatchObject({
          resolution: null,
        });
      });

      it('seals the invocation index and the journal: only the allowlisted definers write them', async () => {
        const sealed = ['session_turn_invocations', 'session_journals', 'session_journal_entries'];
        const owners = await admin<{ relname: string; owner: string }>(
          `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) ORDER BY c.relname COLLATE "C"`,
          [sealed]
        );
        expect(owners).toEqual(
          [...sealed].sort().map((relname) => ({ relname, owner: 'ink_admission_writer' }))
        );
        for (const role of ['service_role', 'anon', 'authenticated']) {
          const [privileges] = await admin<Record<string, boolean>>(
            `SELECT bool_or(has_table_privilege($1, 'public.' || t, 'INSERT')) AS insert,
                    bool_or(has_table_privilege($1, 'public.' || t, 'UPDATE')) AS update,
                    bool_or(has_table_privilege($1, 'public.' || t, 'DELETE')) AS delete,
                    bool_or(has_table_privilege($1, 'public.' || t, 'TRUNCATE')) AS truncate,
                    bool_or(has_table_privilege($1, 'public.' || t, 'REFERENCES')) AS references,
                    bool_or(has_table_privilege($1, 'public.' || t, 'TRIGGER')) AS trigger,
                    bool_and(has_table_privilege($1, 'public.' || t, 'SELECT')) AS select
               FROM unnest($2::text[]) AS t`,
            [role, sealed]
          );
          expect(privileges, role).toEqual({
            insert: false,
            update: false,
            delete: false,
            truncate: false,
            references: false,
            trigger: false,
            select: role === 'service_role',
          });
        }
        const [writer] = await admin(
          `SELECT rolcanlogin, rolsuper, rolinherit, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
             FROM pg_roles WHERE rolname = 'ink_admission_writer'`
        );
        expect(writer).toEqual({
          rolcanlogin: false,
          rolsuper: false,
          rolinherit: false,
          rolbypassrls: true,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        });
        const members = await admin<{ rolname: string }>(
          `SELECT m.rolname FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid
             JOIN pg_roles m ON m.oid = am.member WHERE r.rolname = 'ink_admission_writer'`
        );
        expect(members).toEqual([{ rolname: 'postgres' }]);
        const [schema] = await admin(
          `SELECT has_schema_privilege('service_role', 'ink_admission', 'USAGE') AS service,
                  has_schema_privilege('anon', 'ink_admission', 'USAGE') AS anon,
                  has_schema_privilege('authenticated', 'ink_admission', 'USAGE') AS authenticated,
                  has_schema_privilege('ink_admission_writer', 'public', 'CREATE') AS writer_creates_public,
                  has_schema_privilege('ink_admission_writer', 'ink_admission', 'CREATE') AS writer_creates_private`
        );
        expect(schema).toEqual({
          service: false,
          anon: false,
          authenticated: false,
          writer_creates_public: false,
          writer_creates_private: false,
        });
        // Every function the writer owns, and so every function that runs as it.
        const owned = await admin<{ fn: string; definer: boolean; config: string[] | null }>(
          `SELECT n.nspname || '.' || p.proname AS fn, p.prosecdef AS definer, p.proconfig AS config
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE pg_get_userbyid(p.proowner) = 'ink_admission_writer'
            ORDER BY (n.nspname || '.' || p.proname) COLLATE "C"`
        );
        const definers = [
          'public.append_session_journal',
          'public.hold_session_journal',
          'public.reconcile_tenure',
          'public.record_invocation',
          'public.session_journal_open',
        ];
        const helpers = [
          'ink_admission.invocation_record',
          'ink_admission.journal_eid',
          'ink_admission.journal_entry_refusal',
          'ink_admission.journal_keys_are',
          'ink_admission.journal_pid_valid',
          'ink_admission.journal_string_matches',
          'ink_admission.journal_target_refusal',
          'ink_admission.journal_ts_valid',
          'ink_admission.reconcile_tenure_legacy',
          'ink_admission.reduce_invocation',
        ];
        expect(owned).toEqual(
          [...definers, ...helpers].sort().map((fn) => ({
            fn,
            definer: definers.includes(fn),
            config: ['search_path=""'],
          }))
        );
        const [calls] = await admin(
          `SELECT has_function_privilege('service_role', 'public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer)', 'EXECUTE') AS service_appends,
                  has_function_privilege('anon', 'public.append_session_journal(uuid, uuid, text, text, uuid, bigint, jsonb, integer)', 'EXECUTE') AS anon_appends,
                  has_function_privilege('authenticated', 'public.hold_session_journal(uuid, uuid, text, text, uuid, text, integer)', 'EXECUTE') AS authenticated_holds,
                  has_function_privilege('service_role', 'ink_admission.reduce_invocation(uuid, uuid, text, text, text, jsonb, uuid, bigint)', 'EXECUTE') AS service_reduces,
                  has_function_privilege('service_role', 'ink_admission.reconcile_tenure_legacy(uuid, uuid, text, text, text, text, jsonb, text, text, integer)', 'EXECUTE') AS service_reconciles_directly`
        );
        expect(calls).toEqual({
          service_appends: true,
          anon_appends: false,
          authenticated_holds: false,
          service_reduces: false,
          service_reconciles_directly: false,
        });
        const secrets = await admin(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name IN ('session_journals', 'session_journal_entries')
              AND (column_name ILIKE '%capab%' OR column_name ILIKE '%secret%' OR column_name ILIKE '%hash%')`
        );
        expect(secrets).toEqual([]);
      });

      it('denies service_role every direct write to the sealed tables, through SQL and through PostgREST', async () => {
        const { w, t } = await started();
        await append(w, intent(targetOf(w.holder, t, 'inv-sealed')));
        const client = new Client({
          connectionString: process.env.INTEGRATION_DB_URL,
          statement_timeout: 15_000,
        });
        await client.connect();
        const attempts: Array<[string, string, unknown[]]> = [
          [
            'insert a header',
            "INSERT INTO public.session_journals (session_id, kind) VALUES ($1, 'db_v1')",
            [randomUUID()],
          ],
          [
            'advance a head',
            'UPDATE public.session_journals SET committed_eid = committed_eid + 1 WHERE id = $1',
            [w.journalId],
          ],
          [
            'clear a hold',
            'UPDATE public.session_journals SET hold_reason = NULL WHERE id = $1',
            [w.journalId],
          ],
          ['delete a header', 'DELETE FROM public.session_journals WHERE id = $1', [w.journalId]],
          [
            'delete entries',
            'DELETE FROM public.session_journal_entries WHERE journal_id = $1',
            [w.journalId],
          ],
          ['truncate entries', 'TRUNCATE public.session_journal_entries', []],
          [
            'resolve a spawn',
            "UPDATE public.session_turn_invocations SET resolution = 'tree_quiescent', resolution_evidence_ref = 'forged' WHERE session_id = $1",
            [w.sessionId],
          ],
          [
            'open a spawn',
            "INSERT INTO public.session_turn_invocations (session_id, epoch, invocation_id) VALUES ($1, $2, 'inv-forged')",
            [w.sessionId, t.epoch],
          ],
          [
            'forget a spawn',
            'DELETE FROM public.session_turn_invocations WHERE session_id = $1',
            [w.sessionId],
          ],
          ['truncate the index', 'TRUNCATE public.session_turn_invocations', []],
          [
            'call the reducer',
            `SELECT ink_admission.reduce_invocation($1, $2, $3, 'inv-sealed', 'tree_quiescent', '{"evidenceRef":"x"}'::jsonb, NULL, NULL)`,
            [w.sessionId, w.holder.tenureId, t.epoch],
          ],
        ];
        try {
          for (const [label, sql, params] of attempts) {
            await client.query('BEGIN');
            try {
              await client.query('SET LOCAL ROLE service_role');
              const outcome = await client.query(sql, params).then(
                () => 'written',
                (error: { code?: string }) => error.code
              );
              expect(outcome, label).toBe('42501');
            } finally {
              await client.query('ROLLBACK');
            }
          }
        } finally {
          await client.end();
        }
        const forged = await supabase
          .from('session_turn_invocations')
          .update({ resolution: 'tree_quiescent', resolution_evidence_ref: 'forged' })
          .eq('session_id', w.sessionId)
          .select('invocation_id');
        expect(forged.error?.code).toBe('42501');
        const planted = await supabase.from('session_journal_entries').insert({
          journal_id: w.journalId,
          eid: 2,
          entry: {},
          projection: 'none',
        });
        expect(planted.error?.code).toBe('42501');
        expect(await invocationRow(w.sessionId, t.epoch, 'inv-sealed')).toMatchObject({
          resolution: null,
        });
        expect(await header(w.journalId)).toMatchObject({ committed_eid: 1, hold_reason: null });
      });
    });
  });
});

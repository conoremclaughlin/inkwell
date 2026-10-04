/**
 * Durable command admission against a real database (migration
 * 20261004094856): ordering, dedupe, mode binding, transitions and the
 * unknown-effect hold. These are the invariants concurrency or Postgres
 * semantics decide, so a mock cannot stand in for them.
 *
 * The suite flips the global admission mode to `conditional` and restores
 * `legacy` afterwards. Nothing else reads that row yet.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
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
      await transitionCommand(supabase, {
        commandUuid: c.id,
        expected: { revision: 1, state: 'queued' },
        to: 'unknown',
        reasonCode: 'acceptance_unresolved',
      });
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
      // The command moving on voids the decision, and the hold comes back.
      await transitionCommand(supabase, {
        commandUuid: ids[0],
        expected: { revision: 2, state: 'unknown' },
        to: 'unknown',
        reasonCode: 'acceptance_unresolved',
      });
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
});

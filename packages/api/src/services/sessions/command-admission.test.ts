import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADMISSION_PROTOCOL,
  COMMAND_DIGEST_VERSION,
  admitCommand,
  commandPayloadDigest,
  readDispatchHead,
  transitionCommand,
} from './command-admission';

const SESSION = '11111111-1111-4111-8111-111111111111';
const COMMAND = '22222222-2222-4222-8222-222222222222';

function clientReturning(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('commandPayloadDigest', () => {
  const base = { sessionId: SESSION, kind: 'input.enqueue' as const, payload: { a: 1, b: [2, 3] } };

  it('is the same whatever order the payload keys arrive in', () => {
    expect(commandPayloadDigest(base)).toBe(
      commandPayloadDigest({ ...base, payload: { b: [2, 3], a: 1 } })
    );
  });

  it('changes with the target session, the body and the expected turn', () => {
    const digest = commandPayloadDigest(base);
    expect(commandPayloadDigest({ ...base, sessionId: COMMAND })).not.toBe(digest);
    expect(commandPayloadDigest({ ...base, payload: { a: 2, b: [2, 3] } })).not.toBe(digest);
    expect(commandPayloadDigest({ ...base, payload: { a: 1, b: [3, 2] } })).not.toBe(digest);
    expect(commandPayloadDigest({ ...base, expectedTurn: 'turn-1' })).not.toBe(digest);
  });

  it('names its algorithm', () => {
    expect(commandPayloadDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('admitCommand', () => {
  const input = {
    sessionId: SESSION,
    workspaceId: '33333333-3333-4333-8333-333333333333',
    principal: { kind: 'user' as const, id: 'user-1' },
    commandId: 'command-1',
    kind: 'input.enqueue' as const,
    origin: { kind: 'terminal' as const },
    payload: { text: 'hello' },
  };

  it('sends the digest, its version and the protocol, with absent fields as null', async () => {
    const { client, rpc } = clientReturning({
      outcome: 'admitted',
      id: COMMAND,
      admissionSeq: 1,
      state: 'queued',
      revision: 1,
    });
    await admitCommand(client, input);
    expect(rpc).toHaveBeenCalledWith('admit_command', {
      p_session_id: SESSION,
      p_workspace_id: input.workspaceId,
      p_principal_kind: 'user',
      p_principal_id: 'user-1',
      p_command_id: 'command-1',
      p_payload_digest: commandPayloadDigest(input),
      p_digest_version: COMMAND_DIGEST_VERSION,
      p_kind: 'input.enqueue',
      p_origin_kind: 'terminal',
      p_origin_ref: null,
      p_addressee: null,
      p_payload: { text: 'hello' },
      p_source_message_ref: null,
      p_expected_turn: null,
      p_recipients: [],
      p_protocol: ADMISSION_PROTOCOL,
    });
  });

  it('returns each contracted outcome as parsed', async () => {
    for (const reply of [
      { outcome: 'conflict', id: COMMAND },
      { outcome: 'too_large', limitBytes: 8 },
      { outcome: 'forbidden' },
      { outcome: 'mode_mismatch', mode: 'legacy', protocol: 1 },
      { outcome: 'mode_mismatch', mode: null, protocol: null },
    ]) {
      const { client } = clientReturning(reply);
      expect(await admitCommand(client, input)).toEqual(reply);
    }
  });

  it('throws on a reply outside the contract instead of guessing', async () => {
    for (const reply of [
      null,
      { outcome: 'admitted', id: COMMAND },
      { outcome: 'accepted', id: COMMAND },
      { outcome: 'admitted', id: 'not-a-uuid', admissionSeq: 1, state: 'queued', revision: 1 },
      { outcome: 'admitted', id: COMMAND, admissionSeq: 1, state: 'running', revision: 1 },
    ]) {
      const { client } = clientReturning(reply);
      await expect(admitCommand(client, input)).rejects.toThrow(/outside its contract/);
    }
  });

  it('throws on a transport error', async () => {
    const { client } = clientReturning(null, { message: 'connection reset' });
    await expect(admitCommand(client, input)).rejects.toThrow(
      /admit_command failed: connection reset/
    );
  });
});

describe('transitionCommand', () => {
  it('carries the expected revision and state as the CAS', async () => {
    const { client, rpc } = clientReturning({ outcome: 'stale', revision: 3, state: 'unknown' });
    const result = await transitionCommand(client, {
      commandUuid: COMMAND,
      expected: { revision: 2, state: 'queued' },
      to: 'backend_accepted',
    });
    expect(result).toEqual({ outcome: 'stale', revision: 3, state: 'unknown' });
    expect(rpc).toHaveBeenCalledWith('transition_command', {
      p_command_uuid: COMMAND,
      p_expected_revision: 2,
      p_expected_state: 'queued',
      p_new_state: 'backend_accepted',
      p_reason_code: null,
      p_mark_started: false,
      p_executing_epoch: null,
      p_recipients: [],
      p_protocol: ADMISSION_PROTOCOL,
    });
  });

  it('throws on an unknown outcome', async () => {
    const { client } = clientReturning({ outcome: 'transitioned', revision: 2 });
    await expect(
      transitionCommand(client, {
        commandUuid: COMMAND,
        expected: { revision: 1, state: 'queued' },
        to: 'completed',
      })
    ).rejects.toThrow(/outside its contract/);
  });
});

describe('readDispatchHead', () => {
  it('accepts a head, an empty queue and either hold', async () => {
    for (const reply of [
      { hold: null, holdingCommand: null, head: COMMAND },
      { hold: null, holdingCommand: null, head: null },
      { hold: 'recovery_required', holdingCommand: COMMAND, head: null },
      { hold: 'unresolved_dispatch', holdingCommand: COMMAND, head: null },
    ]) {
      const { client } = clientReturning(reply);
      expect(await readDispatchHead(client, SESSION)).toEqual(reply);
    }
  });

  it('refuses a hold that names no command, a hold beside a head, or an unknown hold', async () => {
    for (const reply of [
      { hold: 'recovery_required', holdingCommand: null, head: null },
      { hold: 'recovery_required', holdingCommand: COMMAND, head: COMMAND },
      { hold: 'paused', holdingCommand: COMMAND, head: null },
    ]) {
      const { client } = clientReturning(reply);
      await expect(readDispatchHead(client, SESSION)).rejects.toThrow(/outside its contract/);
    }
  });
});

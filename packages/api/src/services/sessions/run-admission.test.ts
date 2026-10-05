import { describe, expect, it, vi } from 'vitest';
import type {
  JournalCommitReceipt,
  JournalEntry,
  JournalProjection,
  JournalRecord,
  JournalWriter,
} from '@inklabs/shared/runtime';
import {
  admittedRun,
  type AdmittedTurn,
  type InvocationGate,
  type InvocationPermit,
  type RunAdmissionPorts,
  type RunRequest,
  type SpawnAttempt,
} from './run-admission';

const SESSION = '11111111-1111-4111-8111-111111111111';
const COMMAND = '22222222-2222-4222-8222-222222222222';
const TENURE = '33333333-3333-4333-8333-333333333333';
const JOURNAL = '55555555-5555-4555-8555-555555555555';

const turnRequest: RunRequest = { sessionId: SESSION, commandUuid: COMMAND, kind: 'turn' };
const attempt: SpawnAttempt = {
  adapter: 'claude-code',
  hostMode: 'server_hosted',
  attemptId: 'attempt-1',
  deadlineAt: null,
  execution: { kind: 'known', hostId: 'host-a', bootId: 'boot-a' },
};

/**
 * Fake ports with a call log, so ordering is asserted rather than assumed. The
 * journal echoes the full committed entry, as the real writer's receipt does.
 */
function fakePorts(
  overrides: {
    projection?: (record: JournalRecord) => JournalProjection;
    appendThrows?: (record: JournalRecord) => boolean;
    /** Rewrites the echoed entry, to model a store that disagrees. */
    echo?: (entry: JournalEntry) => JournalEntry;
    failure?: NonNullable<JournalWriter['failure']>;
    barrier?: () => 'clear' | 'held' | 'unverified';
    admit?: RunAdmissionPorts['turns']['admit'];
    authorize?: RunAdmissionPorts['dispatch']['authorize'];
  } = {}
) {
  const calls: string[] = [];
  const appended: JournalRecord[] = [];
  let eid = 0;
  let minted = 0;
  const journal = {
    failure: overrides.failure as JournalWriter['failure'],
    append: vi.fn(async (record: JournalRecord): Promise<JournalCommitReceipt> => {
      calls.push(`append:${record.type}`);
      if (overrides.appendThrows?.(record)) throw new Error('store unavailable');
      // Snapshot what was submitted, as the writer does before its await.
      const snapshot = JSON.parse(JSON.stringify(record)) as JournalRecord;
      appended.push(snapshot);
      eid += 1;
      const entry: JournalEntry = {
        version: 1,
        journalId: JOURNAL,
        sessionId: SESSION,
        writerTenureId: TENURE,
        hostInstanceId: 'host-a',
        eid,
        ts: '2026-10-04T12:00:00.000Z',
        ...snapshot,
      };
      return {
        outcome: 'committed',
        projection: overrides.projection?.(snapshot) ?? 'recorded',
        entry: overrides.echo ? overrides.echo(entry) : entry,
        committedEid: eid,
      };
    }),
  };
  const ports: RunAdmissionPorts = {
    journal,
    turns: {
      admit:
        overrides.admit ??
        vi.fn(async (request: RunRequest) => {
          calls.push(`admit:${request.kind}`);
          return {
            outcome: 'admitted' as const,
            sessionId: request.sessionId,
            tenureId: TENURE,
            epoch: 'epoch-7',
            commandUuid: request.commandUuid,
            kind: request.kind,
          };
        }),
    },
    dispatch: {
      authorize:
        overrides.authorize ??
        vi.fn(async (_turn: AdmittedTurn, invocationId: string) => {
          calls.push(`authorize:${invocationId}`);
          return { outcome: 'dispatch' as const };
        }),
    },
    recovery: { state: overrides.barrier ?? (() => 'clear') },
    mintInvocationId: () => `inv-${++minted}`,
  };
  return { ports, calls, appended, journal };
}

/** A fake physical spawn through the gate, as a runner would do it. */
async function spawnThroughGate(
  gate: InvocationGate,
  calls: string[],
  after?: (permit: InvocationPermit) => Promise<void>
): Promise<string> {
  const permit = await gate.prepare(attempt);
  if ('outcome' in permit) return `refused:${permit.reason}`;
  const refused = gate.admitSpawn(permit);
  if (refused) return `refused:${refused}`;
  calls.push(`spawn:${permit.invocationId}`);
  await after?.(permit);
  return `spawned:${permit.invocationId}`;
}

describe('admittedRun: the outer layer', () => {
  it('refuses with no ports and never runs', async () => {
    const execute = vi.fn();
    expect(await admittedRun(undefined, turnRequest, execute)).toEqual({
      outcome: 'refused',
      reason: 'ports_missing',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['journal', 'turns', 'dispatch', 'recovery'] as const)(
    'refuses when the %s port is missing, before asking anything',
    async (missing) => {
      const { ports, calls } = fakePorts();
      const partial = { ...ports, [missing]: undefined } as unknown as RunAdmissionPorts;
      const execute = vi.fn();
      expect(await admittedRun(partial, turnRequest, execute)).toEqual({
        outcome: 'refused',
        reason: 'ports_missing',
      });
      expect(calls).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it('holds every session while recovery is unverified, before admission is even asked', async () => {
    const { ports, calls } = fakePorts({ barrier: () => 'unverified' });
    const execute = vi.fn();
    expect(await admittedRun(ports, turnRequest, execute)).toMatchObject({
      reason: 'recovery_unverified',
    });
    expect(await admittedRun(ports, { ...turnRequest, kind: 'compaction' }, execute)).toMatchObject(
      {
        reason: 'recovery_unverified',
      }
    );
    expect(calls).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a held session', async () => {
    const { ports } = fakePorts({ barrier: () => 'held' });
    expect(await admittedRun(ports, turnRequest, vi.fn())).toMatchObject({
      reason: 'recovery_held',
    });
  });

  it('refuses when the journal has stopped', async () => {
    const { ports, calls } = fakePorts({ failure: { code: 'append_failed', hold: 'confirmed' } });
    expect(await admittedRun(ports, turnRequest, vi.fn())).toEqual({
      outcome: 'refused',
      reason: 'journal_failed',
      detail: 'append_failed',
    });
    expect(calls).toEqual([]);
  });

  it("passes the turn authority's refusal through and never runs", async () => {
    const { ports } = fakePorts({ admit: async () => ({ outcome: 'refused', reason: 'busy' }) });
    const execute = vi.fn();
    expect(await admittedRun(ports, turnRequest, execute)).toEqual({
      outcome: 'refused',
      reason: 'turn_refused',
      detail: 'busy',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an admission for another command', async () => {
    const { ports } = fakePorts({
      admit: async (request) => ({
        outcome: 'admitted',
        sessionId: request.sessionId,
        tenureId: TENURE,
        epoch: 'epoch-7',
        commandUuid: '44444444-4444-4444-8444-444444444444',
        kind: request.kind,
      }),
    });
    expect(await admittedRun(ports, turnRequest, vi.fn())).toMatchObject({
      reason: 'turn_refused',
      detail: 'admission_mismatch',
    });
  });

  it('takes a compaction (S2) through the same admission as a turn (S1)', async () => {
    const { ports, calls } = fakePorts();
    const outcome = await admittedRun(
      ports,
      { ...turnRequest, kind: 'compaction' },
      async (gate) => {
        expect(gate.turn.kind).toBe('compaction');
        return spawnThroughGate(gate, calls);
      }
    );
    expect(outcome).toMatchObject({ outcome: 'ran', result: 'spawned:inv-1' });
    expect(calls[0]).toBe('admit:compaction');
  });
});

describe('InvocationGate: one physical spawn', () => {
  it('commits the intent, then asks dispatch, then spawns, in that order', async () => {
    const { ports, calls, appended } = fakePorts();
    await admittedRun(ports, turnRequest, (gate) => spawnThroughGate(gate, calls));
    expect(calls).toEqual([
      'admit:turn',
      'append:provider_spawn_intent',
      'authorize:inv-1',
      'spawn:inv-1',
    ]);
    expect(appended[0]).toEqual({
      type: 'provider_spawn_intent',
      target: { tenureId: TENURE, epoch: 'epoch-7', commandUuid: COMMAND, invocationId: 'inv-1' },
      body: {
        adapter: 'claude-code',
        hostMode: 'server_hosted',
        attemptId: 'attempt-1',
        deadlineAt: null,
        execution: { kind: 'known', hostId: 'host-a', bootId: 'boot-a' },
      },
    });
  });

  it.each(['none', 'already_recorded', 'contradiction', 'needs_reconciler'] as const)(
    'refuses before dispatch when the intent projects as %s',
    async (projection) => {
      const { ports, calls } = fakePorts({ projection: () => projection });
      const outcome = await admittedRun(ports, turnRequest, (gate) =>
        spawnThroughGate(gate, calls)
      );
      expect(outcome).toMatchObject({ result: 'refused:projection_not_recorded' });
      expect(calls.some((call) => call.startsWith('authorize:'))).toBe(false);
      expect(calls.some((call) => call.startsWith('spawn:'))).toBe(false);
    }
  );

  it('refuses when the intent cannot be appended', async () => {
    const { ports, calls } = fakePorts({ appendThrows: () => true });
    const outcome = await admittedRun(ports, turnRequest, (gate) => spawnThroughGate(gate, calls));
    expect(outcome).toMatchObject({ result: 'refused:journal_refused' });
    expect(calls.some((call) => call.startsWith('spawn:'))).toBe(false);
  });

  it('refuses when dispatch says no, after the intent committed, and refuses a retry even if dispatch would now say yes', async () => {
    let answers = 0;
    const { ports, calls } = fakePorts({
      authorize: async () =>
        ++answers === 1 ? { outcome: 'refused', reason: 'not_holder' } : { outcome: 'dispatch' },
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => {
      const first = await spawnThroughGate(gate, calls);
      const retry = await spawnThroughGate(gate, calls);
      return [first, retry];
    });
    expect(outcome).toMatchObject({
      result: ['refused:dispatch_refused', 'refused:prior_invocation_unresolved'],
      // The committed intent stays an obligation, though nothing spawned.
      unresolvedInvocations: 1,
    });
    expect(answers).toBe(1);
    expect(calls.some((call) => call.startsWith('spawn:'))).toBe(false);
  });

  it('refuses a dispatch that throws, and allows no retry', async () => {
    const { ports, calls } = fakePorts({
      authorize: async () => {
        throw new Error('authority unreachable');
      },
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => [
      await spawnThroughGate(gate, calls),
      await spawnThroughGate(gate, calls),
    ]);
    expect(outcome).toMatchObject({
      result: ['refused:dispatch_refused', 'refused:prior_invocation_unresolved'],
    });
  });

  it('issues one outstanding permit at a time', async () => {
    const { ports } = fakePorts();
    await admittedRun(ports, turnRequest, async (gate) => {
      const first = await gate.prepare(attempt);
      expect(first).toEqual({ invocationId: 'inv-1' });
      expect(await gate.prepare(attempt)).toMatchObject({ reason: 'prior_invocation_unresolved' });
    });
  });

  it('allows one spawn per permit', async () => {
    const { ports } = fakePorts();
    await admittedRun(ports, turnRequest, async (gate) => {
      const permit = (await gate.prepare(attempt)) as InvocationPermit;
      expect(gate.admitSpawn(permit)).toBeUndefined();
      expect(gate.admitSpawn(permit)).toBe('permit_used');
      expect(gate.admitSpawn({ invocationId: 'inv-1' })).toBe('permit_stale');
    });
  });

  it('refuses synchronously when the run is stopped between prepare and spawn, and allows no retry', async () => {
    const { ports, calls } = fakePorts();
    const controller = new AbortController();
    const outcome = await admittedRun(
      ports,
      turnRequest,
      async (gate) => {
        const permit = (await gate.prepare(attempt)) as InvocationPermit;
        controller.abort();
        const refused = gate.admitSpawn(permit);
        const retry = await spawnThroughGate(gate, calls);
        return [refused, retry];
      },
      { signal: controller.signal }
    );
    expect(outcome).toMatchObject({
      result: ['aborted', 'refused:aborted'],
      // The intent committed; stopping before spawn does not erase the obligation.
      unresolvedInvocations: 1,
    });
    expect(calls.some((call) => call.startsWith('spawn:'))).toBe(false);
  });

  it('refuses at spawn when recovery is held after prepare', async () => {
    let state: 'clear' | 'held' = 'clear';
    const { ports } = fakePorts({ barrier: () => state });
    await admittedRun(ports, turnRequest, async (gate) => {
      const permit = (await gate.prepare(attempt)) as InvocationPermit;
      state = 'held';
      expect(gate.admitSpawn(permit)).toBe('recovery_held');
    });
  });
});

describe('InvocationGate: a runner retry is another physical spawn', () => {
  it("refuses Claude's fresh-session fallback when the first spawn only reports parent_exited", async () => {
    const { ports, calls } = fakePorts();
    const outcome = await admittedRun(ports, turnRequest, async (gate) => {
      const first = await spawnThroughGate(gate, calls, async (permit) => {
        await gate.bind(permit, {
          pid: 4242,
          startIdentity: 'start-1',
          containment: { kind: 'unknown' },
        });
        await gate.observe(permit, { kind: 'parent_exited', evidenceRef: 'exit-1' });
      });
      // "Session not found" from the first attempt is a string, not proof it ran nothing.
      const fallback = await spawnThroughGate(gate, calls);
      return [first, fallback];
    });
    expect(outcome).toMatchObject({
      result: ['spawned:inv-1', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });

  it('allows the next spawn once the first is proved quiescent, with a new invocation and the same attempt', async () => {
    const { ports, calls, appended } = fakePorts();
    const outcome = await admittedRun(ports, turnRequest, async (gate) => {
      const first = await spawnThroughGate(gate, calls, async (permit) => {
        await gate.bind(permit, {
          pid: 4242,
          startIdentity: 'start-1',
          containment: { kind: 'attested_tree', identity: 'tree-1', evidenceRef: 'attest-1' },
        });
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-1' });
      });
      const second = await spawnThroughGate(gate, calls);
      return [first, second];
    });
    expect(outcome).toMatchObject({ result: ['spawned:inv-1', 'spawned:inv-2'] });
    const intents = appended.filter((record) => record.type === 'provider_spawn_intent');
    expect(intents.map((record) => record.target?.invocationId)).toEqual(['inv-1', 'inv-2']);
    expect(intents.map((record) => record.body.attemptId)).toEqual(['attempt-1', 'attempt-1']);
  });

  it('stops an Ink-style attempt loop after a spawn whose group is merely empty', async () => {
    const { ports, calls } = fakePorts();
    const outcome = await admittedRun(ports, turnRequest, async (gate) => {
      const results: string[] = [];
      for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
        results.push(
          await spawnThroughGate(gate, calls, async (permit) => {
            await gate.observe(permit, {
              kind: 'group_empty',
              evidenceRef: `group-${attemptNumber}`,
            });
          })
        );
      }
      return results;
    });
    expect(outcome).toMatchObject({
      result: [
        'spawned:inv-1',
        'refused:prior_invocation_unresolved',
        'refused:prior_invocation_unresolved',
      ],
    });
  });

  it('keeps a started spawn unresolved when its binding cannot be recorded', async () => {
    const { ports, calls } = fakePorts({
      appendThrows: (record) => record.type === 'provider_spawn_binding',
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) =>
      spawnThroughGate(gate, calls, async (permit) => {
        expect(
          await gate.bind(permit, {
            pid: 4242,
            startIdentity: 'start-1',
            containment: { kind: 'unknown' },
          })
        ).toBe('unresolved');
      })
    );
    expect(outcome).toMatchObject({ outcome: 'ran', unresolvedInvocations: 1 });
  });

  it('does not count an observation that failed to commit', async () => {
    const { ports, calls } = fakePorts({
      appendThrows: (record) => record.type === 'provider_spawn_observation',
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => {
      const first = await spawnThroughGate(gate, calls, async (permit) => {
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-1' });
      });
      return [first, await spawnThroughGate(gate, calls)];
    });
    expect(outcome).toMatchObject({
      result: ['spawned:inv-1', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });
});

// Lumen's independent review of f24b2c14 (pr:701 d36f3b22): R1-R4 failed there.
describe('review regressions: preparation, observation, obligations, admission', () => {
  it('R1: concurrent preparation issues at most one outstanding permit', async () => {
    const { ports } = fakePorts();
    await admittedRun(ports, turnRequest, async (gate) => {
      const results = await Promise.all([gate.prepare(attempt), gate.prepare(attempt)]);
      const permits = results.filter((result) => !('outcome' in result));
      expect(permits).toHaveLength(1);
      expect(results.filter((result) => 'outcome' in result)).toEqual([
        { outcome: 'refused', reason: 'prior_invocation_unresolved' },
      ]);
    });
  });

  it('R2: mutating the observation during its append cannot upgrade a parent exit to quiescence', async () => {
    const { ports, journal, appended } = fakePorts();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = journal.append.getMockImplementation()!;
    journal.append.mockImplementation(async (record) => {
      const receipt = await original(record);
      if (record.type === 'provider_spawn_observation') await paused;
      return receipt;
    });
    await admittedRun(ports, turnRequest, async (gate) => {
      const permit = (await gate.prepare(attempt)) as InvocationPermit;
      expect(gate.admitSpawn(permit)).toBeUndefined();
      const observation: { kind: 'parent_exited' | 'tree_quiescent'; evidenceRef: string } = {
        kind: 'parent_exited',
        evidenceRef: 'fixture-parent-close',
      };
      const saving = gate.observe(permit, observation);
      await Promise.resolve();
      observation.kind = 'tree_quiescent';
      release();
      await saving;
      expect(gate.unresolvedInvocations).toBe(1);
      expect(await gate.prepare(attempt)).toMatchObject({ reason: 'prior_invocation_unresolved' });
    });
    expect(appended.at(-1)?.body.kind).toBe('parent_exited');
  });

  it('R2: an echo whose observation differs from what was submitted reopens the spawn', async () => {
    const { ports, calls } = fakePorts({
      echo: (entry) =>
        entry.type === 'provider_spawn_observation'
          ? { ...entry, body: { kind: 'tree_quiescent', evidenceRef: 'not-what-was-sent' } }
          : entry,
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => [
      await spawnThroughGate(gate, calls, async (permit) => {
        await gate.observe(permit, { kind: 'parent_exited', evidenceRef: 'exit-1' });
      }),
      await spawnThroughGate(gate, calls),
    ]);
    expect(outcome).toMatchObject({
      result: ['spawned:inv-1', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });

  it('R3: a committed intent with refused dispatch is still an unresolved obligation', async () => {
    const { ports, calls } = fakePorts({
      authorize: async () => ({ outcome: 'refused', reason: 'not_holder' }),
    });
    const result = await admittedRun(ports, turnRequest, (gate) => spawnThroughGate(gate, calls));
    expect(result).toMatchObject({ outcome: 'ran', unresolvedInvocations: 1 });
  });

  it('R3: an intent whose append threw may have committed: it counts and blocks a retry', async () => {
    let first = true;
    const { ports, calls } = fakePorts({
      appendThrows: (record) => {
        if (record.type !== 'provider_spawn_intent' || !first) return false;
        first = false;
        return true;
      },
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => [
      await spawnThroughGate(gate, calls),
      await spawnThroughGate(gate, calls),
    ]);
    expect(outcome).toMatchObject({
      result: ['refused:journal_refused', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });

  it('R3: an intent that projected as a contradiction counts', async () => {
    const { ports, calls } = fakePorts({ projection: () => 'contradiction' });
    const outcome = await admittedRun(ports, turnRequest, (gate) => spawnThroughGate(gate, calls));
    expect(outcome).toMatchObject({
      result: 'refused:projection_not_recorded',
      unresolvedInvocations: 1,
    });
  });

  it('R3: a negative observation after quiescence reopens the spawn for good', async () => {
    const { ports, calls } = fakePorts();
    const outcome = await admittedRun(ports, turnRequest, async (gate) => [
      await spawnThroughGate(gate, calls, async (permit) => {
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-1' });
        await gate.observe(permit, { kind: 'child_alive', evidenceRef: 'scan-2' });
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-3' });
      }),
      await spawnThroughGate(gate, calls),
    ]);
    expect(outcome).toMatchObject({
      result: ['spawned:inv-1', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });

  it('R3: a failed observation write after quiescence leaves no clean summary', async () => {
    let observations = 0;
    const { ports, calls } = fakePorts({
      appendThrows: (record) =>
        record.type === 'provider_spawn_observation' && ++observations === 2,
    });
    const outcome = await admittedRun(ports, turnRequest, (gate) =>
      spawnThroughGate(gate, calls, async (permit) => {
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-1' });
        await gate.observe(permit, { kind: 'group_empty', evidenceRef: 'group-2' });
      })
    );
    expect(outcome).toMatchObject({ outcome: 'ran', unresolvedInvocations: 1 });
  });

  it('R4: turn admission cannot relabel the requested kind', async () => {
    const { ports } = fakePorts({
      admit: async (request) => ({
        outcome: 'admitted',
        sessionId: request.sessionId,
        commandUuid: request.commandUuid,
        tenureId: TENURE,
        epoch: 'epoch-7',
        kind: 'compaction',
      }),
    });
    const execute = vi.fn();
    expect(await admittedRun(ports, turnRequest, execute)).toMatchObject({
      reason: 'turn_refused',
      detail: 'admission_mismatch',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('R4: a hold that lands during admission refuses, and hands the admitted turn to the host', async () => {
    let state: 'clear' | 'held' = 'clear';
    const { ports } = fakePorts({ barrier: () => state });
    const admit = ports.turns.admit;
    ports.turns.admit = async (request) => {
      const admission = await admit(request);
      state = 'held';
      return admission;
    };
    const execute = vi.fn();
    expect(await admittedRun(ports, turnRequest, execute)).toEqual({
      outcome: 'refused',
      reason: 'recovery_held',
      admittedTurn: {
        sessionId: SESSION,
        tenureId: TENURE,
        epoch: 'epoch-7',
        commandUuid: COMMAND,
        kind: 'turn',
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('R4: a stop during admission refuses before execute', async () => {
    const controller = new AbortController();
    const { ports } = fakePorts();
    const admit = ports.turns.admit;
    ports.turns.admit = async (request) => {
      const admission = await admit(request);
      controller.abort();
      return admission;
    };
    const execute = vi.fn();
    expect(
      await admittedRun(ports, turnRequest, execute, { signal: controller.signal })
    ).toMatchObject({ reason: 'aborted', admittedTurn: { epoch: 'epoch-7' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('R4: the turn the gate holds is frozen', async () => {
    const { ports } = fakePorts();
    await admittedRun(ports, turnRequest, async (gate) => {
      expect(Object.isFrozen(gate.turn)).toBe(true);
    });
  });
});

describe('guards between the intent and the spawn', () => {
  it('refuses, before asking dispatch, when a hold lands while the intent is being appended', async () => {
    let state: 'clear' | 'held' = 'clear';
    const { ports, calls, journal } = fakePorts({ barrier: () => state });
    const original = journal.append.getMockImplementation()!;
    journal.append.mockImplementation(async (record) => {
      const receipt = await original(record);
      if (record.type === 'provider_spawn_intent') state = 'held';
      return receipt;
    });
    const outcome = await admittedRun(ports, turnRequest, (gate) => spawnThroughGate(gate, calls));
    expect(outcome).toMatchObject({ result: 'refused:recovery_held', unresolvedInvocations: 1 });
    expect(calls.some((call) => call.startsWith('authorize:'))).toBe(false);
  });

  it('refuses an intent whose committed echo names another invocation', async () => {
    const { ports, calls } = fakePorts({
      echo: (entry) =>
        entry.type === 'provider_spawn_intent' && entry.target
          ? { ...entry, target: { ...entry.target, invocationId: 'inv-other' } }
          : entry,
    });
    const outcome = await admittedRun(ports, turnRequest, (gate) => spawnThroughGate(gate, calls));
    expect(outcome).toMatchObject({
      result: 'refused:projection_not_recorded',
      unresolvedInvocations: 1,
    });
    expect(calls.some((call) => call.startsWith('authorize:'))).toBe(false);
  });

  it('keeps a spawn unresolved for good when its binding projects as a contradiction', async () => {
    const { ports, calls } = fakePorts({
      projection: (record) =>
        record.type === 'provider_spawn_binding' ? 'contradiction' : 'recorded',
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => [
      await spawnThroughGate(gate, calls, async (permit) => {
        expect(
          await gate.bind(permit, {
            pid: 4242,
            startIdentity: 'start-1',
            containment: { kind: 'unknown' },
          })
        ).toBe('unresolved');
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-1' });
      }),
      await spawnThroughGate(gate, calls),
    ]);
    expect(outcome).toMatchObject({
      result: ['spawned:inv-1', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });
});

describe('the committed echo decides settlement, not what was submitted alone', () => {
  it('does not settle a spawn whose quiescence the store echoed back as something else', async () => {
    const { ports, calls } = fakePorts({
      echo: (entry) =>
        entry.type === 'provider_spawn_observation'
          ? { ...entry, body: { kind: 'parent_exited', evidenceRef: 'store-says-exit' } }
          : entry,
    });
    const outcome = await admittedRun(ports, turnRequest, async (gate) => [
      await spawnThroughGate(gate, calls, async (permit) => {
        await gate.observe(permit, { kind: 'tree_quiescent', evidenceRef: 'attest-1' });
      }),
      await spawnThroughGate(gate, calls),
    ]);
    expect(outcome).toMatchObject({
      result: ['spawned:inv-1', 'refused:prior_invocation_unresolved'],
      unresolvedInvocations: 1,
    });
  });
});

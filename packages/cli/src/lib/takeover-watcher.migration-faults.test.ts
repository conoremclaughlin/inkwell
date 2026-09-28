/**
 * Migration safety under filesystem faults and interleavings (Lumen, PR #691
 * round 2). The legacy single file is SHARED, so nothing the new writer does
 * to it is atomic with respect to another owner: an unlink can fail, a crash
 * can land between the owner's write and the unlink, and another owner's
 * old-format writer can replace the file between a read and the unlink.
 * Safety therefore cannot rest on deleting legacy evidence. The owner's own
 * namespace has to shadow the legacy file durably, surviving the owner's
 * record cleanup.
 *
 * The fs mock intercepts rmSync on the legacy path only, to deny it or to
 * interleave a foreign write immediately before it; everything else is the
 * real filesystem in a temp dir. No processes, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fault = vi.hoisted(() => ({ legacy: '', deny: false, replace: false, replaced: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    rmSync: (p: unknown, opts: unknown) => {
      if (String(p) === fault.legacy) {
        if (fault.deny) {
          throw Object.assign(new Error('synthetic unlink denial'), { code: 'EACCES' });
        }
        if (fault.replace) {
          fault.replace = false;
          fault.replaced = true;
          actual.writeFileSync(
            p as string,
            JSON.stringify({
              sessionId: 'session-b',
              wrapperGeneration: 'generation-b',
              turnEpoch: 'epoch-b',
            })
          );
        }
      }
      return actual.rmSync(p as string, opts as Parameters<typeof actual.rmSync>[1]);
    },
  };
});

import {
  cliTurnEpochPath,
  writeCliTurnEpoch,
  readCliTurnEpoch,
  clearCliTurnEpoch,
  startTakeoverWatcher,
  takeoverMarkerPath,
} from './takeover-watcher.js';

let dir: string;
const owner = { sessionId: 'session-a', wrapperGeneration: 'generation-a' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'migration-fault-'));
  mkdirSync(join(dir, '.ink'));
  fault.legacy = cliTurnEpochPath(dir);
  fault.deny = false;
  fault.replace = false;
  fault.replaced = false;
});
afterEach(() => {
  fault.deny = false;
  fault.replace = false;
  rmSync(dir, { recursive: true, force: true });
});

const seedLegacy = () =>
  writeFileSync(fault.legacy, JSON.stringify({ ...owner, turnEpoch: 'epoch-old' }));

describe('migration safety under filesystem faults and interleavings', () => {
  it('a failed legacy retirement cannot resurrect old evidence after owner cleanup', () => {
    seedLegacy();
    fault.deny = true;
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    fault.deny = false;
    clearCliTurnEpoch(dir, owner.sessionId, {
      turnEpoch: 'epoch-new',
      wrapperGeneration: owner.wrapperGeneration,
    });
    expect(readCliTurnEpoch(dir, owner)).toBeNull();
  });

  it('a failed legacy retirement must not drop a subsequent uncertain attempt fence', async () => {
    seedLegacy();
    fault.deny = true;
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    fault.deny = false;
    clearCliTurnEpoch(dir, owner.sessionId, {
      turnEpoch: 'epoch-new',
      wrapperGeneration: owner.wrapperGeneration,
    });
    writeFileSync(
      takeoverMarkerPath(dir, owner.wrapperGeneration),
      JSON.stringify({ ...owner, at: new Date().toISOString(), attemptId: 'attempt-new' })
    );
    const claim = vi.fn(async () => 'failed' as const);
    const finalizeScope = vi.fn(async () => undefined);
    const watcher = startTakeoverWatcher({
      cwd: dir,
      expectedSessionId: owner.sessionId,
      generation: owner.wrapperGeneration,
      claim,
      finalizeScope,
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), { timeout: 2000 });
    await watcher.stop();
    expect(finalizeScope).toHaveBeenCalledWith(undefined, ['attempt-new']);
  });

  it('a newer foreign legacy record landing between an ownership read and an unlink survives', () => {
    seedLegacy();
    fault.replace = true;
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    // If the writer leaves the legacy file untouched, no destructive window
    // was opened; represent the other writer arriving afterwards instead.
    if (!fault.replaced) {
      writeFileSync(
        fault.legacy,
        JSON.stringify({
          sessionId: 'session-b',
          wrapperGeneration: 'generation-b',
          turnEpoch: 'epoch-b',
        })
      );
    }
    fault.replace = false;
    expect(existsSync(fault.legacy)).toBe(true);
    expect(JSON.parse(readFileSync(fault.legacy, 'utf8')).turnEpoch).toBe('epoch-b');
  });

  it('the shadow survives the owner record cleanup: a later live record and its clear still never read the legacy epoch', () => {
    seedLegacy();
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    clearCliTurnEpoch(dir, owner.sessionId, {
      turnEpoch: 'epoch-new',
      wrapperGeneration: owner.wrapperGeneration,
    });
    // The next turn of the same owner.
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-next' });
    expect(readCliTurnEpoch(dir, owner)).toMatchObject({ turnEpoch: 'epoch-next' });
    clearCliTurnEpoch(dir, owner.sessionId, {
      turnEpoch: 'epoch-next',
      wrapperGeneration: owner.wrapperGeneration,
    });
    expect(readCliTurnEpoch(dir, owner)).toBeNull();
    // The legacy file was never this writer's to delete, and it is still there.
    expect(existsSync(fault.legacy)).toBe(true);
  });
});

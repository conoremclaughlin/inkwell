/**
 * Retirement is permanent, not a snapshot of the legacy file (Lumen, PR #691
 * round 3). A clear that consulted the shared legacy file for permission to
 * forget the migration could be fooled by a read failure, and by an
 * old-format writer publishing this owner's old epoch AFTER the cleanup.
 * And a legacy-only clear that unlinked the shared file could delete another
 * owner's replacement. So: every clear retires in the owner's own namespace,
 * unconditionally, and the shared file is only ever read.
 *
 * The fs mock denies reads of the legacy path or interleaves a foreign write
 * before an unlink of it; everything else is the real filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fault = vi.hoisted(() => ({ legacy: '', denyRead: false, replaceBeforeRm: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: (p: unknown, opts: unknown) => {
      if (String(p) === fault.legacy && fault.denyRead) {
        throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
      }
      return actual.readFileSync(p as string, opts as BufferEncoding);
    },
    rmSync: (p: unknown, opts: unknown) => {
      if (String(p) === fault.legacy && fault.replaceBeforeRm) {
        fault.replaceBeforeRm = false;
        actual.writeFileSync(
          p as string,
          JSON.stringify({
            sessionId: 'session-b',
            wrapperGeneration: 'generation-b',
            turnEpoch: 'epoch-b',
          })
        );
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
} from './takeover-watcher.js';

let dir: string;
const owner = { sessionId: 'session-a', wrapperGeneration: 'generation-a' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retirement-boundary-'));
  mkdirSync(join(dir, '.ink'));
  fault.legacy = cliTurnEpochPath(dir);
  fault.denyRead = false;
  fault.replaceBeforeRm = false;
});
afterEach(() => {
  fault.denyRead = false;
  fault.replaceBeforeRm = false;
  rmSync(dir, { recursive: true, force: true });
});

const seedLegacy = () =>
  writeFileSync(fault.legacy, JSON.stringify({ ...owner, turnEpoch: 'epoch-old' }));
const clearOwn = (turnEpoch: string) =>
  clearCliTurnEpoch(dir, owner.sessionId, {
    turnEpoch,
    wrapperGeneration: owner.wrapperGeneration,
  });

describe('retirement is permanent rather than a legacy-file snapshot', () => {
  it('a failure reading the legacy file during clear cannot reopen the fallback afterwards', () => {
    seedLegacy();
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    fault.denyRead = true;
    clearOwn('epoch-new');
    fault.denyRead = false;
    expect(readCliTurnEpoch(dir, owner)?.turnEpoch).not.toBe('epoch-old');
    expect(readCliTurnEpoch(dir, owner)).toBeNull();
  });

  it('a delayed legacy write after new-format cleanup stays superseded', () => {
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    clearOwn('epoch-new');
    seedLegacy();
    expect(readCliTurnEpoch(dir, owner)).toBeNull();
  });

  it("clearing a legacy-only record never deletes another owner's replacement", () => {
    seedLegacy();
    fault.replaceBeforeRm = true;
    clearOwn('epoch-old');
    fault.replaceBeforeRm = false;
    expect(existsSync(fault.legacy)).toBe(true);
    expect(JSON.parse(readFileSync(fault.legacy, 'utf8')).turnEpoch).toBe('epoch-old');
  });

  it('a legacy-only clear retires in the owner namespace and yields to a newer owner record', () => {
    seedLegacy();
    // The owner's stop retires its legacy evidence: the legacy file is
    // untouched, the owner now has a tombstone, and its record reads as none.
    clearOwn('epoch-old');
    expect(existsSync(fault.legacy)).toBe(true);
    expect(existsSync(cliTurnEpochPath(dir, owner))).toBe(true);
    expect(readCliTurnEpoch(dir, owner)).toBeNull();
    // A newer owner-format record present at retirement time is not overwritten.
    rmSync(cliTurnEpochPath(dir, owner));
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-next' });
    clearOwn('epoch-old');
    expect(readCliTurnEpoch(dir, owner)).toMatchObject({ turnEpoch: 'epoch-next' });
  });

  it('a clear with no legacy file still retires: the next live write replaces the tombstone', () => {
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-new' });
    clearOwn('epoch-new');
    expect(existsSync(cliTurnEpochPath(dir, owner))).toBe(true);
    expect(readCliTurnEpoch(dir, owner)).toBeNull();
    writeCliTurnEpoch(dir, { ...owner, turnEpoch: 'epoch-next' });
    expect(readCliTurnEpoch(dir, owner)).toMatchObject({ turnEpoch: 'epoch-next' });
  });
});

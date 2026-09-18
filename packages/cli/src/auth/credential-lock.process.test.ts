/**
 * The credential file's generation checks, exercised by real operating-system
 * processes against a real filesystem.
 *
 * Everything else about `~/.ink/auth.json` can be tested in one process with
 * stubs, and none of it reaches the property that matters here. The file is
 * shared by every CLI process on the machine — a REPL, an `ink wait` beside it,
 * a hook the server spawned — and the claim being made is about what happens
 * when two of them decide about it at the same moment. A single-process test
 * cannot produce that; it can only produce a simulation of it whose fidelity is
 * the thing in question.
 *
 * So these spawn processes. The first is deterministic and asserts a specific
 * schedule. The second is a genuine race, and asserts an invariant that a lost
 * update violates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { clearAuthIfUnchanged, loadAuth, saveAuth, type StoredAuth } from './tokens.js';

const tokensModule = join(dirname(fileURLToPath(import.meta.url)), 'tokens.ts');

const authFor = (refreshToken: string): StoredAuth => ({
  access_token: `access-for-${refreshToken}`,
  refresh_token: refreshToken,
  expires_in: 3600,
  scope: 'full',
  issued_at: Date.now(),
});

/** Node can run the module directly only if it can strip types. */
function canRunTypeScriptChildren(): boolean {
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', '0'], {
    encoding: 'utf-8',
  });
  return probe.status === 0;
}

function waitForFile(path: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    // Busy-wait: this test is about wall-clock ordering between processes, and
    // an await here would let the event loop reorder what it is measuring.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return false;
}

describe('credential decisions across real processes', () => {
  let origHome: string | undefined;
  let tempHome: string;
  let authPath: string;
  let lockPath: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tempHome = join(tmpdir(), `ink-xproc-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tempHome, '.ink'), { recursive: true });
    process.env.HOME = tempHome;
    authPath = join(tempHome, '.ink', 'auth.json');
    lockPath = `${authPath}.lock`;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('waits for another process to finish before concluding the file is unchanged', () => {
    // The schedule this pins down is the one a comparison cannot survive on its
    // own. Another process is inside its critical section, and it has not
    // written yet — so at the instant we would have looked, the file still
    // holds the secret we presented, and an unguarded compare-and-delete
    // deletes the credential that process is about to write.
    //
    // Deleting it is not a near miss. The winner's rotation is committed
    // server-side; the file is the only copy of the secret it returned.
    saveAuth(authFor('refresh-A'));

    const acquiredMarker = join(tempHome, 'child-acquired');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const { mkdirSync, rmdirSync, writeFileSync } = require('fs');
        const lockPath = process.argv[1];
        const authPath = process.argv[2];
        const marker = process.argv[3];
        mkdirSync(lockPath);
        writeFileSync(marker, 'held');
        // Hold it, doing what a rotation does: the write lands at the END of
        // the critical section, which is what makes the gap dangerous.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        writeFileSync(
          authPath,
          JSON.stringify({
            access_token: 'access-for-refresh-B',
            refresh_token: 'refresh-B',
            expires_in: 3600,
            scope: 'full',
            issued_at: Date.now(),
          })
        );
        rmdirSync(lockPath);
        `,
        lockPath,
        authPath,
        acquiredMarker,
      ],
      { stdio: 'ignore' }
    );

    try {
      expect(waitForFile(acquiredMarker, 5_000)).toBe(true);

      // The child holds the lock and has NOT yet written refresh-B.
      expect(loadAuth()!.refresh_token).toBe('refresh-A');

      const removed = clearAuthIfUnchanged('refresh-A', { lockWaitMs: 5_000 });

      // By the time we got our turn the file had moved on, and we saw that.
      expect(removed).toBe(false);
      expect(existsSync(authPath)).toBe(true);
      expect(loadAuth()!.refresh_token).toBe('refresh-B');
    } finally {
      child.kill();
    }
  }, 20_000);

  it('never loses a generation when several processes rotate the same file', async () => {
    if (!canRunTypeScriptChildren()) {
      // The children import the module under test directly; without type
      // stripping there is nothing to import. Skipping is honest — this
      // assertion is simply not made on that runtime.
      return;
    }

    // A real race, asserted on an invariant rather than on a schedule.
    //
    // Each process walks the file forward one generation at a time, and only
    // ever from the generation it read. So every successful store advances the
    // file by exactly one, and the total number of successes across all of them
    // must equal the generation the file ends on.
    //
    // A lost update breaks that and nothing else does: two processes reading
    // generation N and both storing N+1 report two successes for one advance.
    saveAuth(authFor('gen-0'));

    const childSource = join(tempHome, 'rotate-child.mjs');
    writeFileSync(
      childSource,
      `
      import { loadAuth, saveAuthIfUnchanged } from ${JSON.stringify(tokensModule)};

      const attempts = Number(process.argv[2]);
      let saved = 0;
      for (let i = 0; i < attempts; i++) {
        const current = loadAuth();
        if (!current) continue;
        const generation = Number(current.refresh_token.slice('gen-'.length));
        const outcome = saveAuthIfUnchanged(current.refresh_token, {
          access_token: 'access-for-gen-' + (generation + 1),
          refresh_token: 'gen-' + (generation + 1),
          expires_in: 3600,
          scope: 'full',
          issued_at: Date.now(),
        });
        if (outcome === 'saved') saved++;
      }
      process.stdout.write(String(saved));
      `
    );

    const PROCESSES = 4;
    const ATTEMPTS = 25;

    // Started together and awaited together. Running them one after another
    // would produce no race at all, and the invariant below would hold for the
    // uninteresting reason.
    const children = await Promise.all(
      Array.from(
        { length: PROCESSES },
        () =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(
              process.execPath,
              ['--experimental-strip-types', childSource, String(ATTEMPTS)],
              { env: { ...process.env, HOME: tempHome } }
            );
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => (stdout += chunk));
            child.stderr.on('data', (chunk) => (stderr += chunk));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
          })
      )
    );

    for (const child of children) {
      expect(child.code, child.stderr).toBe(0);
    }

    const reportedSaves = children.reduce((total, child) => total + Number(child.stdout), 0);
    const finalGeneration = Number(
      JSON.parse(readFileSync(authPath, 'utf-8')).refresh_token.slice('gen-'.length)
    );

    // The invariant: one success, one generation.
    expect(reportedSaves).toBe(finalGeneration);

    // And a coverage control, because the invariant is satisfied trivially by a
    // run in which nothing ever overlapped. If the processes genuinely raced,
    // some attempts found the file already advanced by someone else, so the
    // successes must come to less than every process succeeding every time.
    expect(reportedSaves).toBeGreaterThan(0);
    expect(reportedSaves).toBeLessThan(PROCESSES * ATTEMPTS);
  }, 60_000);
});

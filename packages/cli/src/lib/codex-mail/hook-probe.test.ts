/** Built production probe/guardian, only a bounded protocol fixture. No native
 * Codex, provider, real HOME or credentials are reachable from these tests. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCodexMailHooks } from '../../../dist/lib/codex-mail/hook-probe.js';
const fixture = fileURLToPath(new URL('./fixtures/fake-hook-probe.cjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(mode = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'ink-hook-probe-'));
  dirs.push(dir);
  const evidence = join(dir, 'calls.jsonl');
  const options = {
    binary: process.execPath,
    serverArgs: [fixture, evidence, mode],
    cwd: dir,
    env: {
      HOME: dir,
      CODEX_HOME: dir,
      TMPDIR: dir,
      PATH: process.env.PATH,
      INK_CODEX_INKMAIL: '1',
    },
  };
  return {
    options,
    rows: () =>
      readFileSync(evidence, 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s)),
  };
}
function expectReaped(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(); // Liveness query only; never signals an arbitrary process.
}
describe('read-only native hook preflight', () => {
  it.each(['ok', 'collision'])(
    'uses only configuration methods, ignores server request IDs, and reaps its %s owner',
    async (mode) => {
      const f = setup(mode);
      expect(await probeCodexMailHooks(f.options)).toEqual({
        enabled: true,
        sessionHooks: true,
        hooks: { data: [{ hooks: [], errors: [] }] },
      });
      const [owner, ...calls] = f.rows();
      expect(owner.bridge).toBe('0');
      expect(calls.map((c) => c.method)).toEqual([
        'initialize',
        'initialized',
        'config/read',
        'hooks/list',
      ]);
      expect(calls[2].params).toEqual({ cwd: f.options.cwd, includeLayers: true });
      expectReaped(owner.pid);
    }
  );
  it.each(['error', 'exit', 'hang'])(
    'fails closed and reaps the %s peer without leaking raw config errors',
    async (mode) => {
      const f = setup(mode);
      let error: unknown;
      try {
        await probeCodexMailHooks(f.options);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
      expectReaped(f.rows()[0].pid);
    },
    15000
  );
});

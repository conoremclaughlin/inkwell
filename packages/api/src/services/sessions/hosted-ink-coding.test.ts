import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHostedInkCoding } from './hosted-ink-coding';
import { createCodingToolHost } from '@inklabs/shared/node-host';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-coding-')));
  roots.push(cwd);
  const home = join(cwd, 'home'),
    tempDir = join(cwd, 'tmp');
  await mkdir(home);
  await mkdir(tempDir);
  const stop = new AbortController();
  const resolveBinary = vi.fn(async (name: 'rg' | 'fd') => join(cwd, name));
  const scope = await createHostedInkCoding({
    cwd,
    tempDir,
    shell: '/bin/bash',
    env: {
      HOME: home,
      PATH: '/usr/bin:/bin',
      JWT_SECRET: 'should-not-reach-child',
      INK_ACCESS_TOKEN: 'should-not-reach-child',
    },
    resolveBinary,
    signal: stop.signal,
  });
  const host = createCodingToolHost(cwd, scope.ports);
  return { cwd, home, tempDir, scope, host, stop, resolveBinary };
}
describe('actual hosted Pi effects', () => {
  it('runs existing read/write/edit/ls with session cwd and async operations', async () => {
    const h = await fixture();
    try {
      await h.host.call('write', { path: 'file.txt', content: 'hello\nold\n' });
      expect((await h.host.call('read', { path: 'file.txt', offset: 2, limit: 1 })).text).toContain(
        'old'
      );
      await h.host.call('edit', { path: 'file.txt', edits: [{ oldText: 'old', newText: 'new' }] });
      expect(await readFile(join(h.cwd, 'file.txt'), 'utf8')).toBe('hello\nnew\n');
      expect((await h.host.call('ls', {})).text).toContain('file.txt');
      await expect(h.host.call('read', { path: '../outside' })).rejects.toThrow('containment');
      await expect(h.host.call('read', { path: '~/file' })).rejects.toThrow('Hosted coding paths');
    } finally {
      await h.scope.close();
    }
  });
  it('shell sees only the chosen env, handles spill output, and cannot launch after Stop', async () => {
    const h = await fixture();
    vi.stubEnv('HOSTED_TEST_AMBIENT', 'not-for-tools');
    try {
      const result = await h.host.call('bash', {
        command:
          'printf "%s|%s|%s|%s" "$HOME" "$JWT_SECRET" "$INK_ACCESS_TOKEN" "$HOSTED_TEST_AMBIENT"',
      });
      expect(result.text).toBe(`${h.home}|||`);
      // Finite harmless output: exercise the real async spill stream, not a synthetic Pi tool.
      const spilled = await h.host.call('bash', { command: "printf '%060000d' 0" });
      expect(spilled.text).toContain('Full output:');
      expect(String(spilled.text)).toContain(h.tempDir);
      h.stop.abort();
      await expect(h.host.call('bash', { command: 'printf no' })).rejects.toThrow();
    } finally {
      await h.scope.close();
    }
  });
  it('grep/find use explicit executable resolution and a minimal environment', async () => {
    const h = await fixture();
    try {
      const probe =
        '#!/bin/sh\nif [ -n "$JWT_SECRET$INK_ACCESS_TOKEN$HOSTED_TEST_AMBIENT" ]; then exit 91; fi\n';
      await writeFile(
        join(h.cwd, 'rg'),
        probe +
          `printf '%s\\n' '{"type":"match","data":{"path":{"text":"${h.cwd}/file.txt"},"line_number":1,"lines":{"text":"hello\\n"}}}'\n`,
        { mode: 0o700 }
      );
      await writeFile(join(h.cwd, 'fd'), probe + `printf '%s\\n' '${h.cwd}/file.txt'\n`, {
        mode: 0o700,
      });
      vi.stubEnv('HOSTED_TEST_AMBIENT', 'not-for-tools');
      expect((await h.host.call('grep', { pattern: 'hello' })).text).toContain('file.txt:1: hello');
      expect((await h.host.call('find', { pattern: '*.txt' })).text).toBe('file.txt');
      expect(h.resolveBinary.mock.calls.map(([name]) => name)).toEqual(['rg', 'fd']);
    } finally {
      await h.scope.close();
    }
  });
  it('bounds file/output memory and leaves the next independent call usable', async () => {
    const h = await fixture();
    try {
      await writeFile(join(h.cwd, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1));
      await expect(h.host.call('read', { path: 'large' })).rejects.toThrow('byte bound');
      await expect(h.host.call('bash', { command: "printf '%05000000d' 0" })).rejects.toThrow(
        'byte bound'
      );
      expect((await h.host.call('bash', { command: 'printf recovered' })).text).toBe('recovered');
    } finally {
      await h.scope.close();
    }
  });
});

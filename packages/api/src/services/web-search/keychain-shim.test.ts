import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { keychainShim } from './keychain-shim.js';

// Every spawned helper targets this owned inert stand-in, NEVER macOS security.
async function fixture(
  run: (
    invoke: (
      argv: string[],
      input?: string,
      useRealHome?: boolean
    ) => Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      invoked: boolean;
    }>,
    home: string
  ) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "ink-shim-test quote' space-"));
  const native = join(root, 'inert-native');
  const script = join(root, 'security.cjs');
  const launcher = join(root, 'security');
  const marker = join(root, 'invoked');
  const home = join(root, "OS home ' literal $(not-a-command)");
  const source = keychainShim(process.execPath, home, 'synthetic-user', script, marker, native);
  expect(source.program).not.toContain('/usr/bin/security');
  try {
    await writeFile(script, source.program, { mode: 0o700 });
    await writeFile(launcher, source.launcher, { mode: 0o700 });
    // Only printf/cat: no native keychain access, even if the policy fails open.
    await writeFile(native, '#!/bin/sh\nprintf \'%s\\n\' "$HOME" "$@"\n/bin/cat\n', {
      mode: 0o700,
    });
    await run(async (argv, input = '', useRealHome = false) => {
      await rm(marker, { force: true });
      await rm(marker + '-forwarded', { force: true });
      const child = spawn(launcher, argv, {
        env: { HOME: useRealHome ? home : root, PATH: '/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const invoked = await access(marker + '-forwarded').then(
        () => true,
        () => false
      );
      if (invoked) expect(await readFile(marker, 'utf8')).toBe('');
      return { code, stdout, stderr, invoked };
    }, home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const account = 'synthetic-user';
const service = 'Claude Code-credentials';
const line = (hex: string) =>
  `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;

describe('keychain helper policy (inert executable only)', () => {
  it('forwards exact read/write argv, home and interactive bytes without expansion', async () => {
    await fixture(async (invoke, home) => {
      for (const argv of [
        ['find-generic-password', '-a', account, '-w', '-s', service],
        ['add-generic-password', '-U', '-a', account, '-s', service, '-X', 'abcd'],
        ['add-generic-password', '-U', '-a', account, '-s', service, '-X', 'ab'.repeat(2200)],
      ])
        expect(await invoke(argv)).toEqual({
          code: 0,
          stdout: [home, ...argv, ''].join('\n'),
          stderr: '',
          invoked: true,
        });
      expect(await invoke(['-i'], line('abcd'))).toEqual({
        code: 0,
        stdout: `${home}\n-i\n${line('abcd')}`,
        stderr: '',
        invoked: true,
      });
    });
  });

  it('refuses extra commands/services/accounts/options and never calls the stand-in', async () => {
    await fixture(async (invoke) => {
      for (const argv of [
        [],
        ['unexpected'],
        ['-i', 'extra'],
        ['find-generic-password', '-a', 'other', '-w', '-s', service],
        ['find-generic-password', '-a', account, '-w', '-s', 'other'],
        ['find-generic-password', '-a', account, '-w', '-s', service, 'extra'],
        ['add-generic-password', '-U', '-a', account, '-s', service, '-X', '$(printf synthetic)'],
        ['add-generic-password', '-U', '-a', account, '-s', service, '-X', 'abc'],
      ])
        expect(await invoke(argv)).toEqual({ code: 64, stdout: '', stderr: '', invoked: false });
    });
  });

  it('refuses malformed or overlong interactive input rather than parsing a command language', async () => {
    await fixture(async (invoke) => {
      for (const input of [
        '',
        line(''),
        line('abc'),
        line('abc\n'),
        line('zz'),
        line('ab\u0000cd'),
        line('abcd') + '\n',
        line('abcd') + line('abcd'),
        line('abcd').replace(account, 'other'),
        line('abcd').replace(service, 'other'),
        line('$(printf synthetic)'),
        line('abcd').trimEnd(),
        line('ab'.repeat(2017)),
      ])
        expect(await invoke(['-i'], input)).toEqual({
          code: 64,
          stdout: '',
          stderr: '',
          invoked: false,
        });
    });
  });

  it('refuses helper invocation from the real home before native forwarding', async () => {
    await fixture(async (invoke) => {
      expect(
        await invoke(['find-generic-password', '-a', account, '-w', '-s', service], '', true)
      ).toEqual({ code: 64, stdout: '', stderr: '', invoked: false });
    });
  });

  it('refuses bad host paths and account spellings before writing a script', () => {
    for (const home of ['relative', '/synthetic\nhome']) {
      expect(() => keychainShim('/node', home, account, '/script', '/marker')).toThrow(
        'missing_configuration'
      );
    }
    expect(() => keychainShim('/node', '/home', 'unsafe account', '/script', '/marker')).toThrow(
      'missing_configuration'
    );
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginCommand, logoutCommand, registerGoogleCommands, statusCommand } from './google.js';

const cleanup: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-google-cmd-'));
  cleanup.push(dir);
  return dir;
}
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop() as string, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.INK_GOOGLE_CREDENTIALS_DIR;
  process.exitCode = undefined;
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  return { out, err };
}

describe('ink google login — before any network', () => {
  it('prints instructions and exits non-zero when no client file is stored (no stack trace)', async () => {
    process.env.INK_GOOGLE_CREDENTIALS_DIR = join(tempDir(), 'google');
    const { err } = capture();

    await expect(loginCommand({ browser: false })).resolves.toBeUndefined();

    expect(err.join('\n')).toMatch(/ink google login --client/);
    expect(process.exitCode).toBe(1);
  });

  it('refuses a Web-application client with the fix named', async () => {
    const dir = tempDir();
    process.env.INK_GOOGLE_CREDENTIALS_DIR = join(dir, 'google');
    const web = join(dir, 'web.json');
    writeFileSync(web, JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }));
    const { err } = capture();

    await loginCommand({ browser: false, client: web });

    expect(err.join('\n')).toMatch(/Desktop app/);
    expect(process.exitCode).toBe(1);
  });
});

describe('ink google status / logout', () => {
  it('reports an empty directory and a logout of nothing', async () => {
    process.env.INK_GOOGLE_CREDENTIALS_DIR = join(tempDir(), 'google');
    const { out } = capture();

    await statusCommand({});
    expect(out.join('\n')).toMatch(/none — run `ink google login`/);

    logoutCommand('nobody@example.com');
    expect(out.join('\n')).toMatch(/No stored login for nobody@example.com/);
    expect(process.exitCode).toBe(1);
  });
});

describe('ink google', () => {
  it('registers login, status and logout under one group', () => {
    const program = new Command();
    registerGoogleCommands(program);
    const google = program.commands.find((c) => c.name() === 'google');
    expect(google).toBeDefined();
    expect(google?.commands.map((c) => c.name())).toEqual(['login', 'status', 'logout']);
    const login = google?.commands.find((c) => c.name() === 'login');
    expect(login?.options.map((o) => o.long)).toEqual(['--client', '--no-browser']);
  });

  it('is wired into the CLI entrypoint', () => {
    const cli = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts'),
      'utf-8'
    );
    expect(cli).toContain("import { registerGoogleCommands } from './commands/google.js';");
    expect(cli).toContain('registerGoogleCommands(program);');
  });
});

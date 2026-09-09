import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerGoogleCommands } from './google.js';

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

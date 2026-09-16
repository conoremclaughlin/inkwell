import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

import { buildTemplatedCommand, runShellCommand, templateEnvName } from './provider-utils';

/**
 * The value an attacker controls. The payload is a marker-file write: harmless,
 * and unambiguous — the file exists only if the shell executed the substitution
 * rather than treating it as text.
 */
function hostileValue(marker: string): string {
  return `$(printf pwned > ${marker})`;
}

/** What production did before this module owned the substitution. */
function legacyEscapeAndInterpolate(template: string, value: string): string {
  const escaped = `'${value.replace(/'/g, `'\\''`)}'`;
  return template.split('{text}').join(escaped);
}

describe('buildTemplatedCommand', () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ink-template-'));
    marker = path.join(dir, 'executed');
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The whole point of the module: the operator's quoting must not matter.
  const shapes: Array<[string, string]> = [
    ['bare', 'printf %s {text}'],
    ['double-quoted', 'printf %s "{text}"'],
    ['single-quoted', "printf %s '{text}'"],
  ];

  for (const [name, template] of shapes) {
    it(`does not execute a hostile value in a ${name} placeholder`, async () => {
      const value = hostileValue(marker);
      const { command, env } = buildTemplatedCommand(template, { text: value });

      // The value is nowhere near the command line — that is the property.
      expect(command).not.toContain('printf pwned');
      expect(env.INK_TPL_TEXT).toBe(value);

      const result = await runShellCommand(command, 5_000, env);

      expect(existsSync(marker)).toBe(false);
      expect(result.timedOut).toBe(false);
    });
  }

  // Control. Without this, the three tests above pass whether or not a shell
  // could ever have run that payload, and prove nothing.
  it('control: the escape-and-interpolate shape it replaced does execute it', async () => {
    const value = hostileValue(marker);
    const command = legacyEscapeAndInterpolate('printf %s "{text}"', value);

    const result = await runShellCommand(command, 5_000);

    expect(existsSync(marker)).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('delivers the value to the child byte for byte, quotes and all', async () => {
    const value = `it's "quoted" $HOME \`tick\` \\slash`;
    const { command, env } = buildTemplatedCommand('printf %s {text}', { text: value });

    const result = await runShellCommand(command, 5_000, env);

    expect(result.stdout).toBe(value);
  });

  it('substitutes every occurrence of a placeholder', async () => {
    const { command, env } = buildTemplatedCommand('printf "%s-%s" {text} {text}', {
      text: 'x',
    });

    const result = await runShellCommand(command, 5_000, env);

    expect(command).not.toContain('{text}');
    expect(result.stdout).toBe('x-x');
  });

  it('inherits the ambient environment alongside the substituted values', () => {
    const { env } = buildTemplatedCommand('printf %s {text}', { text: 'x' });

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.INK_TPL_TEXT).toBe('x');
  });

  it('warns that a single-quoted placeholder will not substitute', () => {
    buildTemplatedCommand("printf %s '{text}'", { text: 'x' });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('single-quotes a placeholder'),
      expect.objectContaining({ placeholder: 'text' })
    );
  });

  // A regex for this ('[^']*\{text\}) matches here by starting at the CLOSING
  // quote of 'hi'. The template is fine and the operator must not be told it
  // is broken, so the check tracks the shell's quoting state instead.
  it('does not warn about a bare placeholder that merely follows a quoted word', async () => {
    const { command, env } = buildTemplatedCommand("printf %s 'hi' && printf %s {text}", {
      text: 'x',
    });

    expect(warn).not.toHaveBeenCalled();

    const result = await runShellCommand(command, 5_000, env);
    expect(result.stdout).toBe('hix');
  });

  it('does not warn about a placeholder inside double quotes, which substitutes', () => {
    buildTemplatedCommand('printf %s "{text}"', { text: 'x' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a placeholder the caller supplied no value for alone', () => {
    const { command } = buildTemplatedCommand('cmd {input} {mime}', { input: '/tmp/a' });

    expect(command).toBe('cmd "$INK_TPL_INPUT" {mime}');
  });
});

describe('templateEnvName', () => {
  it('uppercases and namespaces the placeholder', () => {
    expect(templateEnvName('text')).toBe('INK_TPL_TEXT');
    expect(templateEnvName('output')).toBe('INK_TPL_OUTPUT');
  });

  it('replaces characters that cannot appear in an env var name', () => {
    expect(templateEnvName('media-type')).toBe('INK_TPL_MEDIA_TYPE');
  });
});

describe('runShellCommand', () => {
  it('reports a non-zero exit rather than throwing', async () => {
    const result = await runShellCommand('exit 3', 5_000);

    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('runs with the ambient environment when none is passed', async () => {
    const result = await runShellCommand('printf %s "$INK_TPL_TEXT"', 5_000);

    expect(result.stdout).toBe('');
  });
});

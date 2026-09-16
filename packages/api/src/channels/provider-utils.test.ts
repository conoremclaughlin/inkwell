import { existsSync, readFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

/** The three contexts a slot can sit in, as an operator would actually write them. */
const CONTEXTS: Array<[string, string]> = [
  ['bare', 'printf "<%s>" {text}'],
  ['double-quoted', 'printf "<%s>" "{text}"'],
  ['single-quoted', `printf "<%s>" '{text}'`],
];

describe('buildTemplatedCommand', () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ink-template-'));
    marker = path.join(dir, 'executed');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('a value is data, whatever the operator quoted', () => {
    for (const [name, template] of CONTEXTS) {
      it(`does not execute a hostile value in a ${name} slot`, async () => {
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

    // Control. Without this the three above pass whether or not a shell could
    // ever have run that payload, and prove nothing.
    it('control: the escape-and-interpolate shape it replaced does execute it', async () => {
      const value = hostileValue(marker);
      const command = legacyEscapeAndInterpolate('printf "<%s>" "{text}"', value);

      const result = await runShellCommand(command, 5_000);

      expect(existsSync(marker)).toBe(true);
      expect(result.timedOut).toBe(false);
    });
  });

  // Inertness is not the whole contract. A value that arrives split into three
  // arguments, or glob-expanded into a filename, is inert and wrong. Every
  // context must also deliver exactly one argument, byte for byte.
  describe('a value arrives as exactly one argument, whatever the operator quoted', () => {
    const awkward: Array<[string, string]> = [
      ['whitespace', 'hello  world\t--synthetic-option'],
      ['glob characters', 'package*.json'],
      ['quotes and a dollar', `it's "quoted" $HOME`],
      ['a backtick and a semicolon', 'tick `here` ; and more'],
      ['a newline', 'first line\nsecond line'],
    ];

    for (const [contextName, template] of CONTEXTS) {
      for (const [valueName, value] of awkward) {
        it(`preserves ${valueName} in a ${contextName} slot`, async () => {
          const { command, env } = buildTemplatedCommand(template, { text: value });

          const result = await runShellCommand(command, 5_000, env);

          expect(result.code).toBe(0);
          expect(result.stdout).toBe(`<${value}>`);
        });
      }
    }
  });

  describe('the quoting the template already opened', () => {
    it('does not add quotes inside double quotes, which would close them', () => {
      const { command } = buildTemplatedCommand('printf %s "{text}"', { text: 'x' });

      // `""${INK_TPL_TEXT}""` would leave the expansion unquoted — the bug Lumen
      // found in the first cut of this module.
      expect(command).toBe('printf %s "${INK_TPL_TEXT}"');
    });

    it('adds quotes when the slot is bare', () => {
      const { command } = buildTemplatedCommand('printf %s {text}', { text: 'x' });

      expect(command).toBe('printf %s "${INK_TPL_TEXT}"');
    });

    it('closes and reopens a single-quoted region rather than giving up on it', () => {
      const { command } = buildTemplatedCommand(`printf %s 'a{text}b'`, { text: 'x' });

      expect(command).toBe(`printf %s 'a'"\${INK_TPL_TEXT}"'b'`);
    });
  });

  // A parameter name runs to the first character that cannot be part of one, so
  // an undelimited `$INK_TPL_TEXT_suffix` names a different, unset variable and
  // expands to nothing. `bare` and `single` happen to be saved by our own quote
  // ending the name; only `double` was exposed. Lumen found it in r1. Delimited
  // uniformly, and covered in all three contexts so the next affix cannot
  // reintroduce it in the two that were only accidentally safe.
  describe('text touching a slot is not swallowed into the variable name', () => {
    const affixes: Array<[string, string, string]> = [
      ['an underscore suffix', '{text}_suffix', 'hello_suffix'],
      ['a letter suffix', '{text}suffix', 'hellosuffix'],
      ['a digit suffix', '{text}2', 'hello2'],
      ['a mixed suffix', '{text}_v2x', 'hello_v2x'],
      ['a prefix', 'pre_{text}', 'pre_hello'],
      ['both ends', 'pre_{text}_post', 'pre_hello_post'],
    ];

    for (const [name, slot, expected] of affixes) {
      for (const [contextName, wrap] of [
        ['bare', (inner: string) => inner],
        ['double-quoted', (inner: string) => `"${inner}"`],
        ['single-quoted', (inner: string) => `'${inner}'`],
      ] as Array<[string, (inner: string) => string]>) {
        it(`preserves ${name} on a ${contextName} slot`, async () => {
          const { command, env } = buildTemplatedCommand(`printf '<%s>' ${wrap(slot)}`, {
            text: 'hello',
          });

          // Guard against the assertion passing because some neighbouring
          // variable happens to be set in this process's environment.
          for (const key of Object.keys(env)) {
            if (key.startsWith('INK_TPL_TEXT') && key !== 'INK_TPL_TEXT') delete env[key];
          }

          const result = await runShellCommand(command, 5_000, env);

          expect(result.code).toBe(0);
          expect(result.stdout).toBe(`<${expected}>`);
        });
      }
    }
  });

  describe('the grammar it claims to parse', () => {
    it('substitutes inside command substitution, as the shipped STT template does', async () => {
      const { command, env } = buildTemplatedCommand(`printf "<%s>" "$(basename {input} .ogg)"`, {
        input: '/tmp/some dir/clip.ogg',
      });

      const result = await runShellCommand(command, 5_000, env);

      expect(result.stdout).toBe('<clip>');
    });

    it('sees a single-quoted slot nested inside command substitution in double quotes', async () => {
      const { command, env } = buildTemplatedCommand(`printf %s "$(printf %s '{text}')"`, {
        text: 'hello',
      });

      const result = await runShellCommand(command, 5_000, env);

      expect(result.stdout).toBe('hello');
    });

    it('substitutes inside backticks', async () => {
      const { command, env } = buildTemplatedCommand('printf "<%s>" `basename {input}`', {
        input: '/tmp/clip.ogg',
      });

      const result = await runShellCommand(command, 5_000, env);

      expect(result.stdout).toBe('<clip.ogg>');
    });

    it('reads a single quote inside double quotes as a literal, not as an opener', async () => {
      // `'%s'` here is two literal apostrophes around %s. A parser that treated
      // them as a quoted region would leave the closing `"` looking like an
      // opener, and read the bare slot as double-quoted.
      const { command, env } = buildTemplatedCommand(`printf "'%s' <%s>" one {text}`, {
        text: 'two  three',
      });

      // Asserted directly: the slot is bare, so it needs OUR quotes. A value
      // without whitespace would render both readings identical and prove
      // nothing — that is how this mutant survived the first matrix.
      expect(command).toBe(`printf "'%s' <%s>" one "\${INK_TPL_TEXT}"`);

      const result = await runShellCommand(command, 5_000, env);

      expect(result.stdout).toBe(`'one' <two  three>`);
    });

    // Substituting one slot at a time lets the quotes introduced for the first
    // change the parse of the second. The template is read once, before any
    // rewriting, which is what makes this hold.
    it('parses every slot against the original template, not a half-rewritten one', async () => {
      const { command, env } = buildTemplatedCommand(`printf "<%s><%s>" "{first}" '{second}'`, {
        first: 'a b',
        second: 'c d',
      });

      const result = await runShellCommand(command, 5_000, env);

      expect(result.stdout).toBe('<a b><c d>');
    });
  });

  // The stated limit, pinned rather than assumed away. "Not re-scanned" holds
  // within one evaluation; a template that hands the value to a second
  // interpreter gets it parsed as code by that interpreter, and no substitution
  // written here can prevent it.
  describe('the documented limit: a template that starts a second interpreter', () => {
    it('re-evaluates the value when the template expands it into an inner shell', async () => {
      const { command, env } = buildTemplatedCommand(`sh -c "printf %s {text}"`, {
        text: '$(printf SUBSTITUTED)',
      });

      const result = await runShellCommand(command, 5_000, env);

      // Documented, not endorsed: the outer shell expands the value into the
      // string, and the inner `sh -c` then parses that string as shell code.
      expect(result.stdout).toBe('SUBSTITUTED');
    });

    it('stays inert when the inner shell does the expansion, which is the form to write', async () => {
      const { command, env } = buildTemplatedCommand(`sh -c 'printf %s "\${INK_TPL_TEXT}"'`, {
        text: '$(printf SUBSTITUTED)',
      });

      const result = await runShellCommand(command, 5_000, env);

      expect(result.stdout).toBe('$(printf SUBSTITUTED)');
    });
  });

  // The safety property must not depend on the parser being right. Whatever
  // context it concludes, the value reaches the shell only as `$NAME`.
  it('never writes a value into the command, whatever context it concludes', () => {
    const templates = [
      'printf %s {text}',
      'printf %s "{text}"',
      `printf %s '{text}'`,
      `printf %s "$(printf %s '{text}')"`,
      'printf %s `{text}`',
      'printf %s \\"{text}\\"',
      `printf %s "unclosed {text}`,
      `printf %s 'unclosed {text}`,
      'printf %s $({text}',
    ];

    for (const template of templates) {
      const { command } = buildTemplatedCommand(template, { text: 'SENTINEL_VALUE' });
      expect(command, `template: ${template}`).not.toContain('SENTINEL_VALUE');
      expect(command, `template: ${template}`).toContain('${INK_TPL_TEXT}');
    }
  });

  it('inherits the ambient environment alongside the substituted values', () => {
    const { env } = buildTemplatedCommand('printf %s {text}', { text: 'x' });

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.INK_TPL_TEXT).toBe('x');
  });

  it('substitutes every occurrence of a placeholder', async () => {
    const { command, env } = buildTemplatedCommand('printf "%s-%s" {text} {text}', { text: 'x' });

    const result = await runShellCommand(command, 5_000, env);

    expect(command).not.toContain('{text}');
    expect(result.stdout).toBe('x-x');
  });

  it('leaves a placeholder the caller supplied no value for alone', () => {
    const { command } = buildTemplatedCommand('cmd {input} {mime}', { input: '/tmp/a' });

    expect(command).toBe('cmd "${INK_TPL_INPUT}" {mime}');
  });
});

/**
 * Doc/code agreement. The `*_CLI_COMMAND` lines in .env.example are what an
 * operator pastes, so they are the templates this module most has to handle.
 * Reading them from the file rather than copying them here means a new example
 * with a shape the parser cannot see fails this suite instead of a deployment.
 *
 * What this block does NOT do, measured rather than assumed: it does not go red
 * against the pre-fix implementation. Every shipped example puts its slot bare,
 * which is exactly why the vulnerability was latent — the bug needed a quoted
 * slot, and none of the examples has one. So this is a forward-looking guard,
 * not a regression test. It does kill real mutants: reverting to interpolation
 * fails 1 of these, and a SLOT_PATTERN that stops matching lowercase names
 * fails 5. The regression evidence lives in the blocks above.
 */
describe('the command templates shipped in .env.example', () => {
  function repoRoot(): string {
    let dir = process.cwd();
    while (!existsSync(path.join(dir, '.env.example'))) {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('.env.example not found above ' + process.cwd());
      dir = parent;
    }
    return dir;
  }

  const shipped = readFileSync(path.join(repoRoot(), '.env.example'), 'utf8')
    .split('\n')
    .map((line) => /^#?\s*[A-Z0-9_]*CLI_COMMAND=(.+)$/.exec(line.trim())?.[1])
    .filter((template): template is string => Boolean(template));

  it('finds the examples it is meant to be checking', () => {
    expect(shipped.length).toBeGreaterThanOrEqual(4);
  });

  for (const template of shipped) {
    it(`substitutes every slot in: ${template.slice(0, 48)}…`, () => {
      const values = {
        input: '/tmp/some dir/clip.ogg',
        mime: 'audio/ogg',
        text: 'spoken words',
        output: '/tmp/some dir/out.ogg',
        format: 'opus',
      };
      const { command } = buildTemplatedCommand(template, values);

      expect(command).not.toMatch(/\{[a-z]+\}/);
      for (const value of Object.values(values)) {
        expect(command).not.toContain(value);
      }
    });
  }

  it('keeps the whole shipped STT template working, both slots and the substitution', async () => {
    const template = shipped.find((t) => t.includes('basename'));
    expect(template).toBeDefined();

    // The command itself needs whisper, so exercise the substitution shape with
    // printf in its place — two slots, one bare and one inside $( ).
    const shape = template!.replace('whisper', 'printf "%s\\n"').replace('cat ', 'printf "%s" ');
    const { command, env } = buildTemplatedCommand(shape, { input: '/tmp/some dir/clip.ogg' });

    expect(command).toContain('"${INK_TPL_INPUT}"');
    expect(command).not.toContain('/tmp/some dir/clip.ogg');

    const result = await runShellCommand(command, 5_000, env);
    expect(result.stdout).toContain('/tmp/some dir/clip.ogg');
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

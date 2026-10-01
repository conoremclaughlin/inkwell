import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const START = '# ink-managed:hooks:start';
const END = '# ink-managed:hooks:end';
export const CODEX_MAIL_HOOKS = [
  ['SessionStart', 'sessionStart', 'on-session-start'],
  ['UserPromptSubmit', 'userPromptSubmit', 'on-prompt'],
  ['Stop', 'stop', 'on-stop'],
] as const;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Migration of OUR marked legacy or previous bridge stanza only. Custom hooks, config
 * and trust records are never replaced; changed commands require native trust
 * review. Normal launch/install remains compatible with older Codex builds. */
export function modernCodexMailHooks(content: string, commandPrefix: string) {
  const hooks = CODEX_MAIL_HOOKS.map(([event, eventName, hook]) => ({
    event,
    eventName,
    command: `${commandPrefix} hooks ${hook} --backend codex --codex-inkmail-only`,
  }));
  const block = [
    START,
    ...hooks.flatMap(({ event, command }) => [
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${JSON.stringify(command)}`,
      'timeout = 60',
      '',
    ]),
    END,
  ].join('\n');
  if (content.includes(block)) return { content, hooks };
  const start = content.indexOf(START),
    end = content.indexOf(END);
  if (start < 0 || end < start || content.indexOf(START, start + 1) >= 0) {
    throw new Error(
      'Codex Inkmail needs the standard ink-managed hook block; run ink hooks install --backend codex first'
    );
  }
  const old = content.slice(start + START.length, end);
  // This migration is deliberately narrow. Unknown or hand-edited marked
  // blocks are not permission to delete their commands.
  const lines = old
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const legacy =
    lines.length === 4 &&
    lines[0] === '[hooks]' &&
    ['session_start', 'session_end', 'user_prompt'].every((key) =>
      lines.some((line) =>
        new RegExp(
          `^${key} = ".* hooks (on-session-start|on-stop|on-prompt) --backend codex"$`
        ).test(line)
      )
    );
  // The previous bridge wrote this exact unguarded shape. Upgrade only the
  // same launcher path; arbitrary commands and trust records stay untouched.
  const previous = block.replaceAll(' --codex-inkmail-only', '');
  const knownPrevious = content.slice(start, end + END.length) === previous;
  if (!legacy && !knownPrevious)
    throw new Error(
      'Codex Inkmail will not overwrite a modified hook block. Review/back up custom hooks first; ' +
        'to regenerate Ink hooks after changing the node binary or CLI checkout, run ' +
        'ink hooks install --backend codex --force, then relaunch --codex-inkmail and review hook trust again'
    );
  return { content: content.slice(0, start) + block + content.slice(end + END.length), hooks };
}

export function prepareCodexMailHooks(cwd: string) {
  const path = join(cwd, '.codex', 'config.toml');
  if (!existsSync(join(cwd, '.codex')))
    throw new Error('Missing Codex project config; run ink init first');
  if (
    lstatSync(join(cwd, '.codex')).isSymbolicLink() ||
    (existsSync(path) && lstatSync(path).isSymbolicLink())
  ) {
    throw new Error('Codex Inkmail will not rewrite a symlinked config directory or file');
  }
  if (!existsSync(path)) throw new Error('Missing Codex project config; run ink init first');
  const before = readFileSync(path, 'utf8');
  const prefix = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('../../cli.js', import.meta.url)))}`;
  const result = modernCodexMailHooks(before, prefix);
  if (before !== result.content) {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, result.content, { flag: 'wx', mode: 0o600 });
    if (readFileSync(path, 'utf8') !== before) {
      unlinkSync(temp);
      throw new Error('Codex config changed during hook preparation');
    }
    renameSync(temp, path);
  }
  return result.hooks;
}

export function hasTrustedCodexMailHooks(
  result: Record<string, any>,
  expected: Array<{ eventName: string; command: string }>
) {
  if (!Array.isArray(result.data) || result.data.length !== 1 || result.data[0].errors?.length)
    return false;
  const hooks = result.data[0].hooks;
  if (!Array.isArray(hooks)) return false;
  return expected.every((wanted) => {
    // Also refuse a second Inkwell handler from a user/project source. It
    // would claim the same turn twice with different epochs.
    const matching = hooks.filter(
      (h: any) =>
        h.eventName === wanted.eventName &&
        typeof h.command === 'string' &&
        /\bhooks (on-session-start|on-prompt|on-stop)\b/.test(h.command)
    );
    return (
      matching.length === 1 &&
      matching[0].command === wanted.command &&
      matching[0].enabled === true &&
      ['trusted', 'managed'].includes(matching[0].trustStatus)
    );
  });
}

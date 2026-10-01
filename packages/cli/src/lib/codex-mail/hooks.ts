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
  const makeHooks = (prefix: string, guarded: boolean) =>
    CODEX_MAIL_HOOKS.map(([event, eventName, hook]) => ({
      event,
      eventName,
      command: `${prefix} hooks ${hook} --backend codex${guarded ? ' --codex-inkmail-only' : ''}`,
    }));
  const render = (prefix: string, guarded: boolean) =>
    [
      START,
      ...makeHooks(prefix, guarded).flatMap(({ event, command }) => [
        `[[hooks.${event}]]`,
        `[[hooks.${event}.hooks]]`,
        'type = "command"',
        `command = ${JSON.stringify(command)}`,
        'timeout = 60',
        '',
      ]),
      END,
    ].join('\n');
  const hooks = makeHooks(commandPrefix, true);
  const block = render(commandPrefix, true);
  const start = content.indexOf(START),
    end = content.indexOf(END);
  if (start < 0 || end < start || content.indexOf(START, start + 1) >= 0) {
    throw new Error(
      'Codex Inkmail needs the standard ink-managed hook block; run ink hooks install --backend codex first'
    );
  }
  const oldBlock = content.slice(start, end + END.length);
  if (oldBlock === block) return { content, hooks };
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
  // Recognize the entire generated shape, not merely a command substring.
  // A node/checkout relocation changes only the common, shell-quoted prefix;
  // hash-based native trust still requires the human to review new commands.
  let knownPrevious = false;
  try {
    const firstCommand = lines.find((line) => line.startsWith('command = '));
    const command: unknown = firstCommand && JSON.parse(firstCommand.slice('command = '.length));
    if (typeof command === 'string') {
      for (const guarded of [false, true]) {
        const suffix = ` hooks on-session-start --backend codex${guarded ? ' --codex-inkmail-only' : ''}`;
        if (!command.endsWith(suffix)) continue;
        const prefix = command.slice(0, -suffix.length);
        if (
          /^'(?:[^']|'\\'')*' '(?:[^']|'\\'')*'$/.test(prefix) &&
          oldBlock === render(prefix, guarded)
        ) {
          knownPrevious = true;
        }
      }
    }
  } catch {
    // Malformed/custom commands are not a managed block to replace.
  }
  if (!legacy && !knownPrevious)
    throw new Error(
      'Codex Inkmail will not overwrite a modified hook block. Review/back up custom hooks first; ' +
        'to deliberately regenerate Ink hooks with the current CLI build, run ' +
        'ink hooks install --backend codex --force, then relaunch --codex-inkmail and review hook trust again'
    );
  return { content: content.slice(0, start) + block + content.slice(end + END.length), hooks };
}

/** Generated handlers for this CLI build. Do not inspect or rewrite a guessed
 * project file: native hook discovery is authoritative, including in worktrees. */
export function codexMailHooks() {
  const prefix = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('../../cli.js', import.meta.url)))}`;
  return CODEX_MAIL_HOOKS.map(([event, eventName, hook]) => ({
    event,
    eventName,
    command: `${prefix} hooks ${hook} --backend codex --codex-inkmail-only`,
  }));
}

export type ExpectedCodexMailHook = { event: string; eventName: string; command: string };

/** Session flags are non-managed hooks: native trust review still applies.
 * Hook layers are additive; use only after checking for existing Ink handlers. */
export function codexMailHookArgs(expected: ExpectedCodexMailHook[]) {
  return expected.flatMap(({ event, command }) => [
    '-c',
    `hooks.${event}=[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, timeout = 60 }] }]`,
  ]);
}

export function codexMailHookState(
  result: Record<string, any>,
  expected: Array<{ eventName: string; command: string }>
): 'ready' | 'missing' | 'conflict' | 'disabled' | 'untrusted' | 'unavailable' {
  if (!Array.isArray(result.data) || result.data.length !== 1 || result.data[0].errors?.length)
    return 'unavailable';
  const hooks = result.data[0].hooks;
  if (!Array.isArray(hooks) || expected.length === 0) return 'unavailable';
  const ink = hooks.filter(
    (h: any) =>
      typeof h.command === 'string' &&
      /\bhooks (on-session-start|on-prompt|on-stop)\b/.test(h.command)
  );
  if (ink.length === 0) return 'missing';
  if (ink.length !== expected.length) return 'conflict';
  const matched = expected.map((wanted) =>
    ink.filter((h: any) => h.eventName === wanted.eventName)
  );
  if (
    matched.some((matches, i) => matches.length !== 1 || matches[0].command !== expected[i].command)
  )
    return 'conflict';
  if (matched.some(([h]) => h.enabled !== true)) return 'disabled';
  if (matched.some(([h]) => !['trusted', 'managed'].includes(h.trustStatus))) return 'untrusted';
  return 'ready';
}

export function hasTrustedCodexMailHooks(
  result: Record<string, any>,
  expected: Array<{ eventName: string; command: string }>
) {
  return codexMailHookState(result, expected) === 'ready';
}

export function codexMailHookWarning(
  state: ReturnType<typeof codexMailHookState> | 'feature-disabled',
  result?: Record<string, any>
) {
  const reason = {
    ready: '',
    missing:
      'Codex did not load the Inkwell hooks; check the effective hook source (linked worktrees may read main)',
    conflict:
      'Codex loaded conflicting or duplicate Inkwell hooks; review their sources with /hooks',
    disabled: 'Inkwell hooks are disabled; enable the three Inkwell handlers with /hooks',
    untrusted:
      'review and trust the three Inkwell hooks with /hooks (re-trust may be needed after switching ink builds)',
    unavailable: 'Codex hook discovery failed; inspect configuration errors with /hooks',
    'feature-disabled':
      'Codex hooks are disabled by configuration; remove the hooks feature override to use live mail',
  }[state];
  const sources =
    state === 'conflict'
      ? [
          ...new Set(
            (result?.data?.[0]?.hooks ?? [])
              .filter(
                (h: any) =>
                  typeof h.command === 'string' &&
                  /\bhooks (on-session-start|on-prompt|on-stop)\b/.test(h.command)
              )
              .map((h: any) =>
                typeof h.sourcePath === 'string'
                  ? h.sourcePath.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500)
                  : 'unknown source'
              )
          ),
        ]
      : [];
  const sourceHint = sources.length
    ? ` (sources: ${sources.join(', ')}; a worktree source may resolve to main)`
    : '';
  return `${reason}${sourceHint}; live mail is paused and unread mail is untouched. Relaunch with --no-codex-inkmail to opt out.`;
}

import { spawn } from 'child_process';
import { logger } from '../utils/logger';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBaseUrl(
  value: string | undefined,
  fallback = DEFAULT_OPENAI_BASE_URL
): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, '');
}

export function parseProviderList(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return fallback;
  return value
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * The env var a `{placeholder}` is passed through. `{text}` -> `INK_TPL_TEXT`.
 */
export function templateEnvName(placeholder: string): string {
  return `INK_TPL_${placeholder.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export interface TemplatedCommand {
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Fill `{placeholder}` slots in an operator-supplied command template without
 * putting any value on the command line.
 *
 * Each value goes to the child through its environment and the placeholder
 * becomes a quoted parameter expansion. That is inert however the operator
 * quoted the placeholder, because a POSIX shell does not re-scan the result of
 * an expansion for command substitution or metacharacters.
 *
 * Interpolating a shell-escaped literal is not inert, which is why this exists
 * and why the `shellEscape` it replaced is gone rather than left for reuse.
 * Wrapping a value in single quotes is only sound when the placeholder sits
 * bare in the template: write it as `say "{text}"` — the natural way — and the
 * escaped value's own quotes close inside the operator's, so `$(...)` in the
 * value runs. provider-utils.test.ts executes both shapes against a real shell.
 *
 * A single-quoted placeholder is reported: `'{text}'` becomes `'"$INK_TPL_TEXT"'`,
 * which is safe but substitutes nothing, so the operator has to hear about it.
 */
export function buildTemplatedCommand(
  template: string,
  values: Record<string, string>
): TemplatedCommand {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let command = template;

  for (const [placeholder, value] of Object.entries(values)) {
    const name = templateEnvName(placeholder);
    env[name] = value;

    if (isSingleQuotedInShell(command, `{${placeholder}}`)) {
      logger.warn('Command template single-quotes a placeholder; it will not be substituted', {
        placeholder,
        hint: `write {${placeholder}} unquoted`,
      });
    }

    command = command.split(`{${placeholder}}`).join(`"$${name}"`);
  }

  return { command, env };
}

/**
 * Whether any occurrence of `needle` in `source` sits inside shell single
 * quotes, where a parameter expansion would not be performed.
 *
 * A regex cannot answer this — `'[^']*\{text\}` matches the safe
 * `echo 'hi' && say {text}` by starting at the closing quote of `'hi'`. This
 * walks the string in the shell's own quoting states instead.
 */
function isSingleQuotedInShell(source: string, needle: string): boolean {
  let state: 'bare' | 'single' | 'double' = 'bare';

  for (let index = 0; index < source.length; index += 1) {
    if (state === 'single' && source.startsWith(needle, index)) return true;

    const char = source[index];
    if (state === 'single') {
      if (char === "'") state = 'bare';
      continue;
    }
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (state === 'double') {
      if (char === '"') state = 'bare';
      continue;
    }
    if (char === "'") state = 'single';
    else if (char === '"') state = 'double';
  }

  return false;
}

export async function runShellCommand(
  command: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        code: null,
        timedOut,
      });
    });
  });
}

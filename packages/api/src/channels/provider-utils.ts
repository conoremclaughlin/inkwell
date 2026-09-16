import { spawn } from 'child_process';

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

/** The quoting a slot sits in, which decides how its expansion must be written. */
type SlotQuote = 'bare' | 'single' | 'double';

interface Slot {
  start: number;
  end: number;
  placeholder: string;
  quote: SlotQuote;
}

/**
 * How an expansion is written so the value survives as exactly one argument.
 *
 * `bare` needs our quotes. `double` must NOT add them: the operator's quotes are
 * already open, so `""$X""` would close and reopen them and leave the expansion
 * unquoted — the value would word-split and glob. `single` cannot expand at all,
 * so the quote is closed, a quoted expansion inserted, and the quote reopened,
 * which is the ordinary shell idiom for exactly this.
 */
const EXPANSION: Record<SlotQuote, (name: string) => string> = {
  bare: (name) => `"$${name}"`,
  double: (name) => `$${name}`,
  single: (name) => `'"$${name}"'`,
};

/**
 * Fill `{placeholder}` slots in an operator-supplied command template without
 * putting any value on the command line.
 *
 * Each value goes to the child through its environment and the placeholder
 * becomes a parameter expansion, quoted for the context it sits in. A POSIX
 * shell does not re-scan the result of an expansion within the same evaluation,
 * so a value containing `$(...)`, backticks or `;` is data in every one of the
 * three contexts.
 *
 * Interpolating a shell-escaped literal is not inert, which is why this exists
 * and why the `shellEscape` it replaced is gone rather than left for reuse.
 * Wrapping a value in single quotes is only sound when the slot sits bare:
 * write it as `say "{text}"` — the natural way — and the escaped value's own
 * quotes close inside the operator's, so `$(...)` in the value runs.
 *
 * THE ONE LIMIT, and it is a real one. "Within the same evaluation" is the whole
 * guarantee. A template that hands the expansion to a second interpreter —
 * `sh -c "... {text}"`, `eval`, `python -c` — gets the value re-parsed by that
 * interpreter as code, and nothing written here can prevent it: the value has to
 * cross into the inner command somehow. Such a template must expand inside the
 * inner shell instead (`sh -c 'printf %s "$INK_TPL_TEXT"'`), where it is a
 * parameter expansion again. provider-utils.test.ts pins this behaviour so the
 * exclusion stays visible rather than being assumed away.
 *
 * A misparse degrades output, never safety: whichever context this concludes,
 * the value reaches the shell only as `$NAME`, never as literal command text.
 * There is a test for that invariant.
 */
export function buildTemplatedCommand(
  template: string,
  values: Record<string, string>
): TemplatedCommand {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [placeholder, value] of Object.entries(values)) {
    env[templateEnvName(placeholder)] = value;
  }

  // One pass over the original template. Substituting placeholder by placeholder
  // would let the quotes introduced for one slot change the parse of the next.
  const slots = findSlots(template).filter((slot) => slot.placeholder in values);

  let command = '';
  let cursor = 0;
  for (const slot of slots) {
    command += template.slice(cursor, slot.start);
    command += EXPANSION[slot.quote](templateEnvName(slot.placeholder));
    cursor = slot.end;
  }
  command += template.slice(cursor);

  return { command, env };
}

const SLOT_PATTERN = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/**
 * Locate every `{placeholder}` in the template and the quoting it sits in.
 *
 * The grammar this understands, and nothing beyond it: backslash escapes outside
 * single quotes; `'...'` (literal, no escapes); `"..."`; `$(...)` command
 * substitution, nested, where quoting restarts; and backtick substitution. A
 * shape outside that list is parsed as whatever these rules make of it, which
 * can only produce a wrongly quoted expansion — see the misparse note above.
 */
function findSlots(template: string): Slot[] {
  interface Frame {
    quote: SlotQuote;
    terminator?: ')' | '`';
  }
  const stack: Frame[] = [{ quote: 'bare' }];
  const slots: Slot[] = [];

  for (let index = 0; index < template.length; index += 1) {
    const frame = stack[stack.length - 1];
    const char = template[index];

    // Before any quoting rule: a slot is a slot in every context, including
    // inside single quotes, which is the context that needs rewriting most.
    const match = SLOT_PATTERN.exec(template.slice(index));
    if (match) {
      slots.push({
        start: index,
        end: index + match[0].length,
        placeholder: match[1],
        quote: frame.quote,
      });
      index += match[0].length - 1;
      continue;
    }

    if (frame.quote === 'single') {
      if (char === "'") frame.quote = 'bare';
      continue;
    }

    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') {
      frame.quote = frame.quote === 'double' ? 'bare' : 'double';
      continue;
    }
    if (char === "'" && frame.quote === 'bare') {
      frame.quote = 'single';
      continue;
    }
    if (char === '$' && template[index + 1] === '(') {
      stack.push({ quote: 'bare', terminator: ')' });
      index += 1;
      continue;
    }
    if (char === '`') {
      if (frame.terminator === '`' && frame.quote === 'bare') stack.pop();
      else stack.push({ quote: 'bare', terminator: '`' });
      continue;
    }
    if (char === ')' && frame.quote === 'bare' && frame.terminator === ')' && stack.length > 1) {
      stack.pop();
      continue;
    }
  }

  return slots;
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

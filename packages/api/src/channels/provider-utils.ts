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

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runShellCommand(
  command: string,
  timeoutMs: number
): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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

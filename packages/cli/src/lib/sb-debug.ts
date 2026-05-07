import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const initializedDirs = new Set<string>();

function envEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isSbDebugEnabled(explicit?: boolean): boolean {
  if (explicit) return true;
  return envEnabled(process.env.SB_DEBUG) || Boolean(process.env.SB_DEBUG_FILE?.trim());
}

export function resolveSbDebugFile(explicitPath?: string): string {
  const fromArg = explicitPath?.trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env.SB_DEBUG_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), '.ink', 'logs', 'sb-debug.log');
}

export function sbDebugLog(
  scope: string,
  event: string,
  payload?: Record<string, unknown>,
  options?: { force?: boolean; file?: string }
): void {
  if (!isSbDebugEnabled(options?.force)) return;

  const targetFile = resolveSbDebugFile(options?.file);
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    scope,
    event,
    cwd: process.cwd(),
    ...(payload || {}),
  };

  try {
    const dir = dirname(targetFile);
    if (!initializedDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      initializedDirs.add(dir);
    }
    appendFileSync(targetFile, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    // Never fail main flow because debug logging failed.
  }
}

export function initSbDebug(options?: {
  enabled?: boolean;
  file?: string;
  context?: Record<string, unknown>;
}): string | undefined {
  if (!isSbDebugEnabled(options?.enabled)) return undefined;

  const file = resolveSbDebugFile(options?.file);
  process.env.SB_DEBUG = '1';
  process.env.SB_DEBUG_FILE = file;

  sbDebugLog(
    'sb',
    'debug_enabled',
    {
      file,
      ...(options?.context || {}),
    },
    { force: true, file }
  );

  return file;
}

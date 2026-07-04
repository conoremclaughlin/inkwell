/**
 * Shim for Claude Code's src/utils/execFileNoThrow.ts
 *
 * The rendering engine's termio/osc.ts uses execFileNoThrow() for
 * clipboard operations (pbcopy/pbpaste, xclip, xsel, etc.).
 * Claude Code's version uses execa; we use child_process directly.
 */

import { execFile as cpExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(cpExecFile);

type ExecFileOptions = {
  abortSignal?: AbortSignal;
  timeout?: number;
  preserveOutputOnError?: boolean;
  useCwd?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: 'ignore' | 'inherit' | 'pipe';
  input?: string;
};

const MS_IN_SECOND = 1000;
const SECONDS_IN_MINUTE = 60;

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {
    timeout: 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    preserveOutputOnError: true,
    useCwd: true,
  }
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return execFileAsync(file, args, {
    timeout: options.timeout ?? 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    signal: options.abortSignal,
    env: options.env,
    maxBuffer: 1_000_000,
  })
    .then(({ stdout, stderr }) => ({
      stdout: stdout || '',
      stderr: stderr || '',
      code: 0,
    }))
    .catch((error: { stdout?: string; stderr?: string; code?: number; message?: string }) => ({
      stdout: (options.preserveOutputOnError !== false && error.stdout) || '',
      stderr: (options.preserveOutputOnError !== false && error.stderr) || '',
      code: error.code ?? 1,
      error: error.message,
    }));
}

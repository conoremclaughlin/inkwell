import { spawn } from 'child_process';
import { getBackend } from '../backends/index.js';
import { extractBackendTokenUsage, type BackendTokenUsage } from './token-usage.js';

export interface BackendRunRequest {
  backend: string;
  agentId: string;
  model?: string;
  prompt: string;
  verbose?: boolean;
  passthroughArgs?: string[];
  timeoutMs?: number;
}

export interface BackendRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  command: string;
  usage?: BackendTokenUsage;
}

export async function runBackendTurn(request: BackendRunRequest): Promise<BackendRunResult> {
  const adapter = getBackend(request.backend);
  // Codex requires `exec` for one-shot/non-interactive turns.
  // Plain `codex <prompt>` enters interactive mode and can fail in non-TTY flows.
  const promptParts = request.backend === 'codex' ? ['exec', request.prompt] : [request.prompt];
  const prepared = adapter.prepare({
    agentId: request.agentId,
    model: request.model,
    prompt: request.prompt,
    promptParts,
    passthroughArgs: request.passthroughArgs || [],
  });

  const started = Date.now();
  const command = `${prepared.binary} ${prepared.args.join(' ')}`;
  let timeoutHandle: NodeJS.Timeout | null = null;

  return new Promise<BackendRunResult>((resolve) => {
    const child = spawn(prepared.binary, prepared.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...prepared.env },
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (request.verbose) process.stdout.write(String(chunk));
    });

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (request.verbose) process.stderr.write(String(chunk));
    });

    const finalize = (exitCode: number) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      prepared.cleanup();
      const trimmedStdout = stdout.trim();
      const trimmedStderr = stderr.trim();
      resolve({
        success: exitCode === 0,
        stdout: trimmedStdout,
        stderr: trimmedStderr,
        exitCode,
        durationMs: Date.now() - started,
        command,
        usage: extractBackendTokenUsage(request.backend, trimmedStdout, trimmedStderr),
      });
    };

    const timeoutMs = request.timeoutMs || 20 * 60 * 1000;
    timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      finalize(124);
    }, timeoutMs);

    child.on('error', (error) => {
      stderr = `${stderr}\n${String(error)}`.trim();
      finalize(1);
    });

    child.on('close', (code) => finalize(code ?? 1));
  });
}

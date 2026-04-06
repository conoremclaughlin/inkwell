import { spawnBackend } from '@inklabs/shared';
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

  const command = `${prepared.binary} ${prepared.args.join(' ')}`;

  const { result } = spawnBackend({
    binary: prepared.binary,
    args: prepared.args,
    env: prepared.env,
    timeoutMs: request.timeoutMs || 20 * 60 * 1000,
    onStdout: request.verbose ? (chunk) => process.stdout.write(chunk) : undefined,
    onStderr: request.verbose ? (chunk) => process.stderr.write(chunk) : undefined,
  });

  const spawnResult = await result;
  prepared.cleanup();

  return {
    success: spawnResult.exitCode === 0,
    stdout: spawnResult.stdout,
    stderr: spawnResult.stderr,
    exitCode: spawnResult.exitCode,
    durationMs: spawnResult.durationMs,
    command,
    usage: extractBackendTokenUsage(request.backend, spawnResult.stdout, spawnResult.stderr),
  };
}

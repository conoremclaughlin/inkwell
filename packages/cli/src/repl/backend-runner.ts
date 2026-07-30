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
  /**
   * Directories containing turn attachments (--attach-file). Adapters
   * grant the backend read access to these (claude: --add-dir) so it can
   * view attached files natively.
   */
  attachmentDirs?: string[];
  /**
   * Resume an existing backend-native session (claude: --resume). When set,
   * only the delta prompt need be sent — the backend already holds the thread.
   */
  backendSessionId?: string;
  /**
   * Seed a NEW backend-native session with this id on a fresh spawn
   * (claude: --session-id). Pass this on the first spawn of a turn, then pass
   * the same id as `backendSessionId` on subsequent spawns to resume it.
   */
  backendSessionSeedId?: string;
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

export interface BackendTurnHandle {
  result: Promise<BackendRunResult>;
  abort: () => void;
}

export function startBackendTurn(request: BackendRunRequest): BackendTurnHandle {
  const adapter = getBackend(request.backend);
  const promptParts = request.backend === 'codex' ? ['exec', request.prompt] : [request.prompt];
  const prepared = adapter.prepare({
    agentId: request.agentId,
    model: request.model,
    prompt: request.prompt,
    promptParts,
    passthroughArgs: request.passthroughArgs || [],
    attachmentDirs: request.attachmentDirs,
    backendSessionId: request.backendSessionId,
    backendSessionSeedId: request.backendSessionSeedId,
  });

  const command = `${prepared.binary} ${prepared.args.join(' ')}`;

  const { child, result } = spawnBackend({
    binary: prepared.binary,
    args: prepared.args,
    env: prepared.env,
    stdinData: prepared.stdinData,
    timeoutMs: request.timeoutMs || 20 * 60 * 1000,
    onStdout: request.verbose ? (chunk) => process.stdout.write(chunk) : undefined,
    onStderr: request.verbose ? (chunk) => process.stderr.write(chunk) : undefined,
  });

  return {
    result: result.then((spawnResult) => {
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
    }),
    abort: () => {
      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 3000);
    },
  };
}

export async function runBackendTurn(request: BackendRunRequest): Promise<BackendRunResult> {
  return startBackendTurn(request).result;
}

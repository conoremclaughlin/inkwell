/** One backend status, diagnostic and usage schema for the CLI and hosted composition. */
import { classifyError } from '../errors/classify-error.js';
import type { BackendRunResult } from '../providers/backend-runner.js';

export function backendTurnActivity(input: {
  sbSlug: string;
  sessionId: string;
  studioId?: string;
  backend: string;
  durationSeconds: number;
  result: BackendRunResult;
}): Record<string, unknown> {
  const { result, durationSeconds } = input;
  const error = result.success
    ? null
    : classifyError({
        errorText: result.stderr || result.stdout,
        backend: input.backend,
        exitCode: result.exitCode,
      });
  return {
    sbSlug: input.sbSlug,
    type: result.success ? 'agent_complete' : 'error',
    subtype: 'backend_cli:ink',
    content: result.success
      ? `Backend turn completed (ink, ${durationSeconds}s)`
      : `Backend turn failed (ink, ${error?.category || 'exit ' + result.exitCode}): ${error?.summary || result.stderr.slice(0, 200) || 'unknown error'}`,
    sessionId: input.sessionId,
    status: result.success ? 'completed' : 'failed',
    payload: {
      backend: 'ink',
      exitCode: result.exitCode,
      durationMs: durationSeconds * 1000,
      studioId: input.studioId,
      ...(result.success ? {} : { stderr: result.stderr.slice(0, 2000) }),
      ...(error
        ? { errorCategory: error.category, errorSummary: error.summary, retryable: error.retryable }
        : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    },
  };
}

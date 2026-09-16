import { logger } from '../../utils/logger';
import { buildTemplatedCommand, runShellCommand } from '../provider-utils';
import type { AudioTranscriptionProvider, AudioTranscriptionInput } from './stt-provider';

function normalizeMime(value?: string): string {
  if (!value) return 'application/octet-stream';
  return value.trim() || 'application/octet-stream';
}

export class CliTranscriptionProvider implements AudioTranscriptionProvider {
  readonly name = 'cli';

  constructor(
    private readonly commandTemplate: string,
    private readonly timeoutMs: number
  ) {}

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    const { command, env } = buildTemplatedCommand(this.commandTemplate, {
      input: input.filePath,
      mime: normalizeMime(input.contentType),
    });

    const result = await runShellCommand(command, this.timeoutMs, env);
    if (result.timedOut || result.code !== 0) {
      logger.warn('Audio transcription CLI provider failed', {
        code: result.code,
        timedOut: result.timedOut,
        stderr: result.stderr.slice(0, 200),
      });
      return undefined;
    }

    const transcript = result.stdout.trim();
    return transcript || undefined;
  }
}

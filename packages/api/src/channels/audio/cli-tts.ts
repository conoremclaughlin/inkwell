import { stat } from 'fs/promises';
import { logger } from '../../utils/logger';
import { runShellCommand, shellEscape } from '../provider-utils';
import {
  createTempAudioPath,
  removeTempAudioDir,
  extensionForFormat,
  contentTypeForFormat,
} from './audio-utils';
import type { TextToSpeechProvider, TextToSpeechInput, SynthesizedAudio } from './tts-provider';

export class CliTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'cli';

  constructor(
    private readonly commandTemplate: string,
    private readonly timeoutMs: number,
    private readonly format: string
  ) {}

  async synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined> {
    const prompt = input.text.trim();
    if (!prompt) return undefined;

    const extension = extensionForFormat(this.format);
    const filePath = await createTempAudioPath(extension);
    const command = this.commandTemplate
      .replace(/\{text\}/g, shellEscape(prompt))
      .replace(/\{output\}/g, shellEscape(filePath))
      .replace(/\{format\}/g, shellEscape(this.format));

    const result = await runShellCommand(command, this.timeoutMs);
    if (result.timedOut || result.code !== 0) {
      await removeTempAudioDir(filePath);
      logger.warn('TTS CLI provider failed', {
        code: result.code,
        timedOut: result.timedOut,
        stderr: result.stderr.slice(0, 200),
      });
      return undefined;
    }

    try {
      const details = await stat(filePath);
      if (details.size <= 0) {
        await removeTempAudioDir(filePath);
        return undefined;
      }
    } catch {
      await removeTempAudioDir(filePath);
      return undefined;
    }

    return {
      filePath,
      contentType: contentTypeForFormat(this.format),
      filename: `reply.${extension}`,
      cleanup: async () => {
        await removeTempAudioDir(filePath);
      },
    };
  }
}

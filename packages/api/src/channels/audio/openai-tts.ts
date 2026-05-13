import { writeFile, rm } from 'fs/promises';
import { truncate } from '../provider-utils';
import { createTempAudioPath, extensionForFormat, contentTypeForFormat } from './audio-utils';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderConfig,
  TextToSpeechInput,
  SynthesizedAudio,
} from './tts-provider';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'opus';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 4_000;

export class OpenAITextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'openai';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly format: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;

  constructor(config: TextToSpeechProviderConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model || DEFAULT_MODEL;
    this.voice = config.voice || DEFAULT_VOICE;
    this.format = config.format || DEFAULT_FORMAT;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxChars = config.maxChars || DEFAULT_MAX_CHARS;
  }

  async synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined> {
    if (!this.apiKey) return undefined;

    const prompt = truncate(input.text.trim(), this.maxChars);
    if (!prompt) return undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: prompt,
          response_format: this.format,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return undefined;

      const arrayBuffer = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      if (bytes.length === 0) return undefined;

      const extension = extensionForFormat(this.format);
      const filePath = await createTempAudioPath(extension);
      await writeFile(filePath, bytes);

      return {
        filePath,
        contentType: contentTypeForFormat(this.format),
        filename: `reply.${extension}`,
        cleanup: async () => {
          await rm(filePath, { force: true }).catch(() => {});
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

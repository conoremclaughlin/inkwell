import { writeFile, rm } from 'fs/promises';
import { truncate } from '../provider-utils';
import { createTempAudioPath } from './audio-utils';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderConfig,
  TextToSpeechInput,
  SynthesizedAudio,
} from './tts-provider';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const DEFAULT_FORMAT = 'mp3_44100_128';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 5_000;

function outputFormatToExtension(format: string): string {
  if (format.startsWith('mp3')) return 'mp3';
  if (format.startsWith('pcm')) return 'pcm';
  if (format === 'ulaw_8000') return 'wav';
  return 'mp3';
}

function outputFormatToContentType(format: string): string {
  if (format.startsWith('mp3')) return 'audio/mpeg';
  if (format.startsWith('pcm')) return 'audio/L16';
  if (format === 'ulaw_8000') return 'audio/wav';
  return 'audio/mpeg';
}

export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'elevenlabs';
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
      const url = `${this.baseUrl}/text-to-speech/${this.voice}?output_format=${this.format}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: prompt,
          model_id: this.model,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return undefined;

      const arrayBuffer = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      if (bytes.length === 0) return undefined;

      const extension = outputFormatToExtension(this.format);
      const filePath = await createTempAudioPath(extension);
      await writeFile(filePath, bytes);

      return {
        filePath,
        contentType: outputFormatToContentType(this.format),
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

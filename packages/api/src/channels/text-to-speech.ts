import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import {
  normalizeBaseUrl,
  parseIntEnv,
  parseProviderList,
  runShellCommand,
  shellEscape,
  truncate,
} from './provider-utils';

const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'opus';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_PROVIDER_ORDER = ['openai', 'cli'];

function normalizeFormat(value: string | undefined): string {
  const format = value?.trim().toLowerCase();
  if (!format) return DEFAULT_FORMAT;
  return format;
}

function extensionForFormat(format: string): string {
  switch (format) {
    case 'mp3':
      return 'mp3';
    case 'wav':
      return 'wav';
    case 'pcm':
      return 'pcm';
    case 'flac':
      return 'flac';
    case 'opus':
      return 'ogg';
    default:
      return 'ogg';
  }
}

function contentTypeForFormat(format: string): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/L16';
    case 'flac':
      return 'audio/flac';
    case 'opus':
      return 'audio/ogg';
    default:
      return 'audio/ogg';
  }
}

async function createTempAudioPath(extension: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pcp-tts-'));
  return path.join(dir, `${randomUUID()}.${extension}`);
}

export interface TextToSpeechInput {
  text: string;
}

export interface SynthesizedAudio {
  filePath: string;
  contentType: string;
  filename: string;
  cleanup: () => Promise<void>;
}

export interface TextToSpeechConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
  voice: string;
  format: string;
  timeoutMs: number;
  maxChars: number;
  providers?: string[];
  cliCommand?: string;
}

interface TextToSpeechProvider {
  name: string;
  synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined>;
}

class OpenAITextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'openai';

  constructor(
    private readonly config: Pick<
      TextToSpeechConfig,
      'apiKey' | 'baseUrl' | 'model' | 'voice' | 'format' | 'timeoutMs' | 'maxChars'
    >
  ) {}

  async synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined> {
    if (!this.config.apiKey) return undefined;

    const prompt = truncate(input.text.trim(), this.config.maxChars);
    if (!prompt) return undefined;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          voice: this.config.voice,
          input: prompt,
          response_format: this.config.format,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return undefined;

      const arrayBuffer = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      if (bytes.length === 0) return undefined;

      const extension = extensionForFormat(this.config.format);
      const filePath = await createTempAudioPath(extension);
      await writeFile(filePath, bytes);

      return {
        filePath,
        contentType: contentTypeForFormat(this.config.format),
        filename: `reply.${extension}`,
        cleanup: async () => {
          await rm(path.dirname(filePath), { recursive: true, force: true });
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

class CliTextToSpeechProvider implements TextToSpeechProvider {
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
      await rm(path.dirname(filePath), { recursive: true, force: true });
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
        await rm(path.dirname(filePath), { recursive: true, force: true });
        return undefined;
      }
    } catch {
      await rm(path.dirname(filePath), { recursive: true, force: true });
      return undefined;
    }

    return {
      filePath,
      contentType: contentTypeForFormat(this.format),
      filename: `reply.${extension}`,
      cleanup: async () => {
        await rm(path.dirname(filePath), { recursive: true, force: true });
      },
    };
  }
}

export class TextToSpeechService {
  private readonly providers: TextToSpeechProvider[];

  static fromEnv(): TextToSpeechService {
    const enabled = process.env.AUDIO_TTS_ENABLED === 'true';
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = normalizeBaseUrl(process.env.AUDIO_TTS_BASE_URL);
    const model = process.env.AUDIO_TTS_MODEL?.trim() || DEFAULT_MODEL;
    const voice = process.env.AUDIO_TTS_VOICE?.trim() || DEFAULT_VOICE;
    const format = normalizeFormat(process.env.AUDIO_TTS_FORMAT);
    const timeoutMs = parseIntEnv(process.env.AUDIO_TTS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxChars = parseIntEnv(process.env.AUDIO_TTS_MAX_CHARS, DEFAULT_MAX_CHARS);
    const providers = parseProviderList(process.env.AUDIO_TTS_PROVIDERS, DEFAULT_PROVIDER_ORDER);
    const cliCommand = process.env.AUDIO_TTS_CLI_COMMAND?.trim();

    return new TextToSpeechService({
      enabled,
      apiKey,
      baseUrl,
      model,
      voice,
      format,
      timeoutMs,
      maxChars,
      providers,
      cliCommand,
    });
  }

  constructor(
    private readonly config: TextToSpeechConfig,
    providers?: TextToSpeechProvider[]
  ) {
    this.providers = providers ?? this.buildProviders();
  }

  private buildProviders(): TextToSpeechProvider[] {
    const configured = this.config.providers?.length
      ? this.config.providers
      : DEFAULT_PROVIDER_ORDER;
    const providers: TextToSpeechProvider[] = [];

    for (const name of configured) {
      if (name === 'openai') {
        providers.push(
          new OpenAITextToSpeechProvider({
            apiKey: this.config.apiKey,
            baseUrl: this.config.baseUrl,
            model: this.config.model,
            voice: this.config.voice,
            format: this.config.format,
            timeoutMs: this.config.timeoutMs,
            maxChars: this.config.maxChars,
          })
        );
      } else if (name === 'cli' && this.config.cliCommand) {
        providers.push(
          new CliTextToSpeechProvider(
            this.config.cliCommand,
            this.config.timeoutMs,
            this.config.format
          )
        );
      }
    }

    return providers;
  }

  isEnabled(): boolean {
    return Boolean(this.config.enabled && this.providers.length > 0);
  }

  async synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined> {
    if (!this.isEnabled()) return undefined;

    for (const provider of this.providers) {
      try {
        const result = await provider.synthesize(input);
        if (result) return result;
      } catch (error) {
        logger.warn('TTS provider failed', {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return undefined;
  }
}

import { logger } from '../utils/logger';
import { normalizeBaseUrl, parseIntEnv, parseProviderList } from './provider-utils';
import {
  OpenAITextToSpeechProvider,
  ElevenLabsTextToSpeechProvider,
  CliTextToSpeechProvider,
} from './audio';
import type { TextToSpeechProvider, TextToSpeechInput, SynthesizedAudio } from './audio';

export type { TextToSpeechInput, SynthesizedAudio };

const DEFAULT_PROVIDER_ORDER = ['openai', 'cli'];

function normalizeFormat(value: string | undefined): string {
  const format = value?.trim().toLowerCase();
  if (!format) return 'opus';
  return format;
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
  elevenlabsApiKey?: string;
  elevenlabsVoice?: string;
  elevenlabsModel?: string;
}

export class TextToSpeechService {
  private readonly providers: TextToSpeechProvider[];

  static fromEnv(): TextToSpeechService {
    const enabled = process.env.AUDIO_TTS_ENABLED === 'true';
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = normalizeBaseUrl(process.env.AUDIO_TTS_BASE_URL);
    const model = process.env.AUDIO_TTS_MODEL?.trim() || 'gpt-4o-mini-tts';
    const voice = process.env.AUDIO_TTS_VOICE?.trim() || 'alloy';
    const format = normalizeFormat(process.env.AUDIO_TTS_FORMAT);
    const timeoutMs = parseIntEnv(process.env.AUDIO_TTS_TIMEOUT_MS, 30_000);
    const maxChars = parseIntEnv(process.env.AUDIO_TTS_MAX_CHARS, 4_000);
    const providers = parseProviderList(process.env.AUDIO_TTS_PROVIDERS, DEFAULT_PROVIDER_ORDER);
    const cliCommand = process.env.AUDIO_TTS_CLI_COMMAND?.trim();
    const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
    const elevenlabsVoice = process.env.ELEVENLABS_TTS_VOICE?.trim();
    const elevenlabsModel = process.env.ELEVENLABS_TTS_MODEL?.trim();

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
      elevenlabsApiKey,
      elevenlabsVoice,
      elevenlabsModel,
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
      switch (name) {
        case 'openai':
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
          break;
        case 'elevenlabs':
          providers.push(
            new ElevenLabsTextToSpeechProvider({
              apiKey: this.config.elevenlabsApiKey,
              voice: this.config.elevenlabsVoice,
              model: this.config.elevenlabsModel,
              timeoutMs: this.config.timeoutMs,
            })
          );
          break;
        case 'cli':
          if (this.config.cliCommand) {
            providers.push(
              new CliTextToSpeechProvider(
                this.config.cliCommand,
                this.config.timeoutMs,
                this.config.format
              )
            );
          }
          break;
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

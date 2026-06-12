import { stat } from 'fs/promises';
import { logger } from '../utils/logger';
import { normalizeBaseUrl, parseIntEnv, parseProviderList, truncate } from './provider-utils';
import {
  OpenAITranscriptionProvider,
  CliTranscriptionProvider,
  ParakeetTranscriptionProvider,
} from './audio';
import type { AudioTranscriptionProvider, AudioTranscriptionInput } from './audio';

export type { AudioTranscriptionInput };

// parakeet sits between openai and cli: it self-disables when the
// parakeet-mlx binary is absent (lazy per-call availability check), so
// including it by default costs nothing for users who haven't installed
// it — and installing it (e.g. via the setup_audio_transcription MCP
// tool) enables on-device transcription with zero config.
const DEFAULT_PROVIDER_ORDER = ['openai', 'parakeet', 'cli'];

export interface AudioTranscriptionConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxBytes: number;
  maxChars: number;
  providers?: string[];
  cliCommand?: string;
}

export class AudioTranscriptionService {
  private readonly providers: AudioTranscriptionProvider[];

  static fromEnv(): AudioTranscriptionService {
    const enabled = process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false';
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = normalizeBaseUrl(process.env.AUDIO_TRANSCRIPTION_BASE_URL);
    const model = process.env.AUDIO_TRANSCRIPTION_MODEL?.trim() || 'gpt-4o-mini-transcribe';
    const timeoutMs = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS, 30_000);
    const maxBytes = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_MAX_BYTES, 20 * 1024 * 1024);
    const maxChars = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_MAX_CHARS, 4_000);
    const providers = parseProviderList(
      process.env.AUDIO_TRANSCRIPTION_PROVIDERS,
      DEFAULT_PROVIDER_ORDER
    );
    const cliCommand = process.env.AUDIO_TRANSCRIPTION_CLI_COMMAND?.trim();

    return new AudioTranscriptionService({
      enabled,
      apiKey,
      baseUrl,
      model,
      timeoutMs,
      maxBytes,
      maxChars,
      providers,
      cliCommand,
    });
  }

  constructor(
    private readonly config: AudioTranscriptionConfig,
    providers?: AudioTranscriptionProvider[]
  ) {
    this.providers = providers ?? this.buildProviders();
  }

  private buildProviders(): AudioTranscriptionProvider[] {
    const configured = this.config.providers?.length
      ? this.config.providers
      : DEFAULT_PROVIDER_ORDER;
    const providers: AudioTranscriptionProvider[] = [];

    for (const name of configured) {
      switch (name) {
        case 'openai':
          providers.push(
            new OpenAITranscriptionProvider({
              apiKey: this.config.apiKey,
              baseUrl: this.config.baseUrl,
              model: this.config.model,
              timeoutMs: this.config.timeoutMs,
            })
          );
          break;
        case 'parakeet':
          providers.push(
            new ParakeetTranscriptionProvider({
              // First transcription downloads model weights (~600MB) —
              // give it headroom beyond the steady-state timeout
              timeoutMs: Math.max(this.config.timeoutMs, 180_000),
            })
          );
          break;
        case 'cli':
          if (this.config.cliCommand) {
            providers.push(
              new CliTranscriptionProvider(this.config.cliCommand, this.config.timeoutMs)
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

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    if (!this.isEnabled()) return undefined;

    try {
      const details = await stat(input.filePath);
      if (details.size <= 0 || details.size > this.config.maxBytes) {
        return undefined;
      }

      for (const provider of this.providers) {
        try {
          const transcript = await provider.transcribe(input);
          if (transcript?.trim()) {
            return truncate(transcript.trim(), this.config.maxChars);
          }
        } catch (error) {
          logger.warn('Audio transcription provider failed', {
            provider: provider.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return undefined;
    } catch (error) {
      logger.warn('Audio transcription preflight failed', {
        filePath: input.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

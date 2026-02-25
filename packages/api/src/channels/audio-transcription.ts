import { readFile, stat } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_PROVIDER_ORDER = ['openai'];

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

function normalizeMime(value?: string): string {
  if (!value) return 'application/octet-stream';
  return value.trim() || 'application/octet-stream';
}

function parseProviderList(value: string | undefined): string[] {
  if (!value?.trim()) return DEFAULT_PROVIDER_ORDER;
  return value
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runShellCommand(
  command: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        code: null,
        timedOut,
      });
    });
  });
}

export interface AudioTranscriptionInput {
  filePath: string;
  contentType?: string;
  filename?: string;
}

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

interface AudioTranscriptionProvider {
  name: string;
  transcribe(input: AudioTranscriptionInput): Promise<string | undefined>;
}

class OpenAITranscriptionProvider implements AudioTranscriptionProvider {
  readonly name = 'openai';

  constructor(
    private readonly config: Pick<
      AudioTranscriptionConfig,
      'apiKey' | 'baseUrl' | 'model' | 'timeoutMs'
    >
  ) {}

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    if (!this.config.apiKey) return undefined;

    const bytes = await readFile(input.filePath);
    const filename = input.filename?.trim() || path.basename(input.filePath) || 'audio';
    const mime = normalizeMime(input.contentType);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append('model', this.config.model);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        return undefined;
      }

      const payload = (await response.json()) as { text?: string };
      return payload.text?.trim() || undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class CliTranscriptionProvider implements AudioTranscriptionProvider {
  readonly name = 'cli';

  constructor(
    private readonly commandTemplate: string,
    private readonly timeoutMs: number
  ) {}

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    const command = this.commandTemplate
      .replace(/\{input\}/g, shellEscape(input.filePath))
      .replace(/\{mime\}/g, shellEscape(normalizeMime(input.contentType)));

    const result = await runShellCommand(command, this.timeoutMs);
    if (result.timedOut || result.code !== 0) {
      return undefined;
    }

    const transcript = result.stdout.trim();
    return transcript || undefined;
  }
}

export class AudioTranscriptionService {
  private readonly providers: AudioTranscriptionProvider[];

  static fromEnv(): AudioTranscriptionService {
    const enabled = process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false';
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = normalizeBaseUrl(process.env.AUDIO_TRANSCRIPTION_BASE_URL);
    const model = process.env.AUDIO_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL;
    const timeoutMs = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxBytes = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_MAX_BYTES, DEFAULT_MAX_BYTES);
    const maxChars = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_MAX_CHARS, DEFAULT_MAX_CHARS);
    const providers = parseProviderList(process.env.AUDIO_TRANSCRIPTION_PROVIDERS);
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
      if (name === 'openai') {
        providers.push(
          new OpenAITranscriptionProvider({
            apiKey: this.config.apiKey,
            baseUrl: this.config.baseUrl,
            model: this.config.model,
            timeoutMs: this.config.timeoutMs,
          })
        );
      } else if (name === 'cli' && this.config.cliCommand) {
        providers.push(new CliTranscriptionProvider(this.config.cliCommand, this.config.timeoutMs));
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
          void error;
        }
      }

      return undefined;
    } catch (error) {
      void error;
      return undefined;
    }
  }
}

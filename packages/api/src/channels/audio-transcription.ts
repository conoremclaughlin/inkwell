import { readFile, stat } from 'fs/promises';
import path from 'path';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_MAX_CHARS = 4_000;

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
}

export class AudioTranscriptionService {
  static fromEnv(): AudioTranscriptionService {
    const enabled = process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false';
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = normalizeBaseUrl(process.env.AUDIO_TRANSCRIPTION_BASE_URL);
    const model = process.env.AUDIO_TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL;
    const timeoutMs = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxBytes = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_MAX_BYTES, DEFAULT_MAX_BYTES);
    const maxChars = parseIntEnv(process.env.AUDIO_TRANSCRIPTION_MAX_CHARS, DEFAULT_MAX_CHARS);
    return new AudioTranscriptionService({
      enabled,
      apiKey,
      baseUrl,
      model,
      timeoutMs,
      maxBytes,
      maxChars,
    });
  }

  constructor(private readonly config: AudioTranscriptionConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.enabled && this.config.apiKey);
  }

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    if (!this.isEnabled()) return undefined;

    try {
      const details = await stat(input.filePath);
      if (details.size <= 0 || details.size > this.config.maxBytes) {
        return undefined;
      }

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
        const transcript = payload.text?.trim();
        if (!transcript) return undefined;
        return transcript.length > this.config.maxChars
          ? `${transcript.slice(0, this.config.maxChars)}…`
          : transcript;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      void error;
      return undefined;
    }
  }
}

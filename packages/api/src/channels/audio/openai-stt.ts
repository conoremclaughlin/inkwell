import { readFile } from 'fs/promises';
import path from 'path';
import type {
  AudioTranscriptionProvider,
  AudioTranscriptionProviderConfig,
  AudioTranscriptionInput,
} from './stt-provider';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeMime(value?: string): string {
  if (!value) return 'application/octet-stream';
  return value.trim() || 'application/octet-stream';
}

export class OpenAITranscriptionProvider implements AudioTranscriptionProvider {
  readonly name = 'openai';
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: AudioTranscriptionProviderConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model || DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    if (!this.apiKey) return undefined;

    const bytes = await readFile(input.filePath);
    const filename = input.filename?.trim() || path.basename(input.filePath) || 'audio';
    const mime = normalizeMime(input.contentType);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append('model', this.model);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) return undefined;

      const payload = (await response.json()) as { text?: string };
      return payload.text?.trim() || undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

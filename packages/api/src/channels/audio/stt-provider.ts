export interface AudioTranscriptionInput {
  filePath: string;
  contentType?: string;
  filename?: string;
}

export interface AudioTranscriptionProvider {
  readonly name: string;
  transcribe(input: AudioTranscriptionInput): Promise<string | undefined>;
}

export interface AudioTranscriptionProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

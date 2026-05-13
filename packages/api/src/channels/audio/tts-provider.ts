export interface TextToSpeechInput {
  text: string;
}

export interface SynthesizedAudio {
  filePath: string;
  contentType: string;
  filename: string;
  cleanup: () => Promise<void>;
}

export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined>;
}

export interface TextToSpeechProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: string;
  timeoutMs?: number;
  maxChars?: number;
}

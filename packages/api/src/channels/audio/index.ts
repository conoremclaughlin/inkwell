export type {
  TextToSpeechProvider,
  TextToSpeechProviderConfig,
  TextToSpeechInput,
  SynthesizedAudio,
} from './tts-provider';
export type {
  AudioTranscriptionProvider,
  AudioTranscriptionProviderConfig,
  AudioTranscriptionInput,
} from './stt-provider';

export { OpenAITextToSpeechProvider } from './openai-tts';
export { ElevenLabsTextToSpeechProvider } from './elevenlabs-tts';
export { CliTextToSpeechProvider } from './cli-tts';
export { OpenAITranscriptionProvider } from './openai-stt';
export { CliTranscriptionProvider } from './cli-stt';

export { extensionForFormat, contentTypeForFormat, createTempAudioPath } from './audio-utils';

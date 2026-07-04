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
export {
  MlxAudioTextToSpeechProvider,
  mlxPythonCandidates,
  ffmpegCandidates,
  DEFAULT_MLX_TTS_MODEL,
  DEFAULT_MLX_TTS_VOICE,
} from './mlx-tts';
export { OpenAITranscriptionProvider } from './openai-stt';
export { CliTranscriptionProvider } from './cli-stt';
export {
  ParakeetTranscriptionProvider,
  parakeetBinaryCandidates,
  DEFAULT_PARAKEET_MODEL,
} from './parakeet-stt';

export {
  extensionForFormat,
  contentTypeForFormat,
  createTempAudioPath,
  removeTempAudioDir,
} from './audio-utils';

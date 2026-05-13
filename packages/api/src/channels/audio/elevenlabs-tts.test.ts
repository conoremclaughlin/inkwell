import { rm, readFile } from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTextToSpeechProvider } from './elevenlabs-tts';

describe('ElevenLabsTextToSpeechProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when no API key is set', async () => {
    const provider = new ElevenLabsTextToSpeechProvider({});
    const result = await provider.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty text', async () => {
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    const result = await provider.synthesize({ text: '   ' });
    expect(result).toBeUndefined();
  });

  it('synthesizes audio via ElevenLabs API', async () => {
    const raw = new Uint8Array([0x66, 0x61, 0x6b, 0x65, 0x2d, 0x6d, 0x70, 0x33]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      }))
    );

    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: 'test-key',
      voice: 'test-voice',
      model: 'eleven_flash_v2_5',
    });

    const result = await provider.synthesize({ text: 'hello world' });
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('audio/mpeg');
    expect(result!.filename).toBe('reply.mp3');

    const written = await readFile(result!.filePath);
    expect(written.length).toBe(raw.length);

    await result!.cleanup();
  });

  it('sends correct request parameters', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from('audio').buffer.slice(0),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: 'my-key',
      voice: 'my-voice',
      model: 'my-model',
      format: 'pcm_16000',
      baseUrl: 'https://custom.api.com/v1',
    });

    const result = await provider.synthesize({ text: 'test' });
    expect(result).toBeDefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://custom.api.com/v1/text-to-speech/my-voice?output_format=pcm_16000');
    expect(options.method).toBe('POST');
    expect(options.headers['xi-api-key']).toBe('my-key');

    const body = JSON.parse(options.body);
    expect(body.text).toBe('test');
    expect(body.model_id).toBe('my-model');

    await result!.cleanup();
  });

  it('returns undefined on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }))
    );

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    const result = await provider.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('returns undefined on empty response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
      }))
    );

    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key' });
    const result = await provider.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });
});

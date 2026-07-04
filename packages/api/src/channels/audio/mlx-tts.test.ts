import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MlxAudioTextToSpeechProvider, mlxPythonCandidates } from './mlx-tts.js';

describe('mlxPythonCandidates', () => {
  it('puts the env override first when set', () => {
    process.env.AUDIO_TTS_MLX_PYTHON = '/custom/python3';
    try {
      const candidates = mlxPythonCandidates();
      expect(candidates[0]).toBe('/custom/python3');
      expect(candidates).toContain('python3');
    } finally {
      delete process.env.AUDIO_TTS_MLX_PYTHON;
    }
  });

  it('omits the override slot when unset', () => {
    delete process.env.AUDIO_TTS_MLX_PYTHON;
    expect(mlxPythonCandidates()[0]).toBe('python3');
  });
});

describe('MlxAudioTextToSpeechProvider', () => {
  let dir: string;
  let fakePython: string;
  let fakeFfmpeg: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mlx-tts-test-'));

    // A fake python: answers the `-c "import mlx_audio"` probe, and on
    // generate writes <file_prefix>.wav (containing the --text value)
    // into --output_path like the real CLI does with --join_audio.
    fakePython = join(dir, 'fake-python');
    await writeFile(
      fakePython,
      '#!/bin/sh\n' +
        'if [ "$1" = "-c" ]; then exit 0; fi\n' +
        'outdir=""; prefix=""; text=""\n' +
        'prev=""\n' +
        'for arg in "$@"; do\n' +
        '  if [ "$prev" = "--output_path" ]; then outdir="$arg"; fi\n' +
        '  if [ "$prev" = "--file_prefix" ]; then prefix="$arg"; fi\n' +
        '  if [ "$prev" = "--text" ]; then text="$arg"; fi\n' +
        '  prev="$arg"\n' +
        'done\n' +
        'printf "RIFF:%s" "$text" > "$outdir/$prefix.wav"\n'
    );
    await chmod(fakePython, 0o755);

    // A fake ffmpeg: answers -version, writes fake bytes to the last arg.
    fakeFfmpeg = join(dir, 'fake-ffmpeg');
    await writeFile(
      fakeFfmpeg,
      '#!/bin/sh\n' +
        'if [ "$1" = "-version" ]; then echo ffmpeg; exit 0; fi\n' +
        'for last in "$@"; do :; done\n' +
        'printf "OggS:fake-opus" > "$last"\n'
    );
    await chmod(fakeFfmpeg, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('synthesizes wav and cleans up its temp dir', async () => {
    const provider = new MlxAudioTextToSpeechProvider({
      format: 'wav',
      pythonCandidates: [fakePython],
    });
    const result = await provider.synthesize({ text: 'hello world' });
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('audio/wav');
    expect(result!.filename).toBe('reply.wav');
    const content = await readFile(result!.filePath, 'utf-8');
    expect(content).toBe('RIFF:hello world');

    await result!.cleanup();
    await expect(stat(dirname(result!.filePath))).rejects.toThrow();
  });

  it('re-encodes to ogg/opus when format is opus and ffmpeg is available', async () => {
    const provider = new MlxAudioTextToSpeechProvider({
      format: 'opus',
      pythonCandidates: [fakePython],
      ffmpegBinCandidates: [fakeFfmpeg],
    });
    const result = await provider.synthesize({ text: 'voice bubble' });
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('audio/ogg');
    expect(result!.filename).toBe('reply.ogg');
    const content = await readFile(result!.filePath, 'utf-8');
    expect(content).toBe('OggS:fake-opus');
    await result!.cleanup();
  });

  it('falls back to wav when opus is requested but ffmpeg is unavailable', async () => {
    const provider = new MlxAudioTextToSpeechProvider({
      format: 'opus',
      pythonCandidates: [fakePython],
      ffmpegBinCandidates: ['/nonexistent/ffmpeg'],
    });
    const result = await provider.synthesize({ text: 'no ffmpeg here' });
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('audio/wav');
    expect(result!.filename).toBe('reply.wav');
    await result!.cleanup();
  });

  it('truncates text to maxChars before synthesis', async () => {
    const provider = new MlxAudioTextToSpeechProvider({
      format: 'wav',
      maxChars: 5,
      pythonCandidates: [fakePython],
    });
    const result = await provider.synthesize({ text: 'truncate me please' });
    expect(result).toBeDefined();
    const content = await readFile(result!.filePath, 'utf-8');
    expect(content).toBe('RIFF:trunc');
    await result!.cleanup();
  });

  it('self-disables (returns undefined) when no python has mlx_audio', async () => {
    const provider = new MlxAudioTextToSpeechProvider({
      pythonCandidates: ['/nonexistent/python3'],
    });
    const result = await provider.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty text', async () => {
    const provider = new MlxAudioTextToSpeechProvider({
      pythonCandidates: [fakePython],
    });
    expect(await provider.synthesize({ text: '   ' })).toBeUndefined();
  });

  it('falls back to wav when ffmpeg resolves but fails during encode', async () => {
    // ffmpeg that passes the -version probe but exits nonzero on the
    // actual encode — the synthesized WAV must survive, not be discarded.
    const brokenFfmpeg = join(dir, 'broken-ffmpeg');
    await writeFile(
      brokenFfmpeg,
      '#!/bin/sh\nif [ "$1" = "-version" ]; then echo ffmpeg; exit 0; fi\nexit 2\n'
    );
    await chmod(brokenFfmpeg, 0o755);
    const provider = new MlxAudioTextToSpeechProvider({
      format: 'opus',
      pythonCandidates: [fakePython],
      ffmpegBinCandidates: [brokenFfmpeg],
    });
    const result = await provider.synthesize({ text: 'encode failure' });
    expect(result).toBeDefined();
    expect(result!.contentType).toBe('audio/wav');
    expect(result!.filename).toBe('reply.wav');
    const content = await readFile(result!.filePath, 'utf-8');
    expect(content).toBe('RIFF:encode failure');
    await result!.cleanup();
  });

  it('kills a TERM-ignoring child on timeout — nothing outlives synthesize()', async () => {
    // A "python" that ignores SIGTERM and loops forever: only the SIGKILL
    // escalation can stop it. synthesize() must not return while it lives.
    const pidFile = join(dir, 'hang.pid');
    const hangPython = join(dir, 'hang-python');
    await writeFile(
      hangPython,
      '#!/bin/sh\n' +
        'if [ "$1" = "-c" ]; then exit 0; fi\n' +
        `echo $$ > "${pidFile}"\n` +
        "trap '' TERM\n" +
        'while true; do sleep 0.2; done\n'
    );
    await chmod(hangPython, 0o755);

    const provider = new MlxAudioTextToSpeechProvider({
      format: 'wav',
      timeoutMs: 300,
      killGraceMs: 300,
      pythonCandidates: [hangPython],
    });
    const result = await provider.synthesize({ text: 'hang forever' });
    expect(result).toBeUndefined();

    const pid = parseInt((await readFile(pidFile, 'utf-8')).trim(), 10);
    expect(pid).toBeGreaterThan(0);
    // Signal 0 probes liveness — ESRCH means the process group is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('returns undefined (not a throw) when generation fails', async () => {
    const brokenPython = join(dir, 'broken-python');
    await writeFile(
      brokenPython,
      '#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho "boom" >&2\nexit 2\n'
    );
    await chmod(brokenPython, 0o755);
    const provider = new MlxAudioTextToSpeechProvider({
      format: 'wav',
      pythonCandidates: [brokenPython],
    });
    const result = await provider.synthesize({ text: 'hello' });
    expect(result).toBeUndefined();
  });

  it('caches python resolution within the TTL', async () => {
    const provider = new MlxAudioTextToSpeechProvider({ pythonCandidates: [fakePython] });
    expect(await provider.resolvePython()).toBe(fakePython);
    expect(await provider.resolvePython()).toBe(fakePython);
  });

  it('uses per-call voice override when provided', async () => {
    const voiceCapture = join(dir, 'voice-capture');
    const voicePython = join(dir, 'voice-python');
    await writeFile(
      voicePython,
      '#!/bin/sh\n' +
        'if [ "$1" = "-c" ]; then exit 0; fi\n' +
        'outdir=""; prefix=""; voice=""\n' +
        'prev=""\n' +
        'for arg in "$@"; do\n' +
        '  if [ "$prev" = "--output_path" ]; then outdir="$arg"; fi\n' +
        '  if [ "$prev" = "--file_prefix" ]; then prefix="$arg"; fi\n' +
        '  if [ "$prev" = "--voice" ]; then voice="$arg"; fi\n' +
        '  prev="$arg"\n' +
        'done\n' +
        `printf "%s" "$voice" > "${voiceCapture}"\n` +
        'printf "RIFF:audio" > "$outdir/$prefix.wav"\n'
    );
    await chmod(voicePython, 0o755);

    const provider = new MlxAudioTextToSpeechProvider({
      format: 'wav',
      voice: 'serena',
      pythonCandidates: [voicePython],
    });

    const result = await provider.synthesize({ text: 'hello', voice: 'vivian' });
    expect(result).toBeDefined();
    const usedVoice = await readFile(voiceCapture, 'utf-8');
    expect(usedVoice).toBe('vivian');
    await result!.cleanup();
  });

  it('falls back to configured voice when no per-call override', async () => {
    const voiceCapture = join(dir, 'voice-capture-default');
    const voicePython = join(dir, 'voice-python-default');
    await writeFile(
      voicePython,
      '#!/bin/sh\n' +
        'if [ "$1" = "-c" ]; then exit 0; fi\n' +
        'outdir=""; prefix=""; voice=""\n' +
        'prev=""\n' +
        'for arg in "$@"; do\n' +
        '  if [ "$prev" = "--output_path" ]; then outdir="$arg"; fi\n' +
        '  if [ "$prev" = "--file_prefix" ]; then prefix="$arg"; fi\n' +
        '  if [ "$prev" = "--voice" ]; then voice="$arg"; fi\n' +
        '  prev="$arg"\n' +
        'done\n' +
        `printf "%s" "$voice" > "${voiceCapture}"\n` +
        'printf "RIFF:audio" > "$outdir/$prefix.wav"\n'
    );
    await chmod(voicePython, 0o755);

    const provider = new MlxAudioTextToSpeechProvider({
      format: 'wav',
      voice: 'ryan',
      pythonCandidates: [voicePython],
    });

    const result = await provider.synthesize({ text: 'hello' });
    expect(result).toBeDefined();
    const usedVoice = await readFile(voiceCapture, 'utf-8');
    expect(usedVoice).toBe('ryan');
    await result!.cleanup();
  });
});

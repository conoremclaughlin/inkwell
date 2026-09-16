import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CliTextToSpeechProvider } from './cli-tts';
import { CliTranscriptionProvider } from './cli-stt';

/**
 * These exercise the providers themselves, not the substitution helper.
 *
 * Lumen's finding on the first cut: dropping the `env` argument at cli-tts's own
 * `runShellCommand` call survived every helper test, because a helper test never
 * reaches the call site. Each case here runs a real command template through the
 * real provider and asserts the value arrived, so a call site that forgets to
 * forward `env` produces an empty expansion and goes red.
 */
describe('CliTextToSpeechProvider', () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ink-cli-tts-'));
    marker = path.join(dir, 'executed');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('delivers the spoken text to the command and returns the file it wrote', async () => {
    const provider = new CliTextToSpeechProvider('printf %s {text} > {output}', 5_000, 'opus');

    const audio = await provider.synthesize({ text: 'hello  world' });

    expect(audio).toBeDefined();
    expect(await readFile(audio!.filePath, 'utf8')).toBe('hello  world');
    expect(audio!.contentType).toBe('audio/ogg');
    await audio!.cleanup();
  });

  it('passes the format through as its own argument', async () => {
    const provider = new CliTextToSpeechProvider(
      'printf "%s|%s" {text} {format} > {output}',
      5_000,
      'mp3'
    );

    const audio = await provider.synthesize({ text: 'spoken' });

    expect(await readFile(audio!.filePath, 'utf8')).toBe('spoken|mp3');
    await audio!.cleanup();
  });

  it('treats a hostile reply body as text, not as a command', async () => {
    const provider = new CliTextToSpeechProvider('printf %s {text} > {output}', 5_000, 'opus');
    const hostile = `$(printf pwned > ${marker})`;

    const audio = await provider.synthesize({ text: hostile });

    expect(existsSync(marker)).toBe(false);
    expect(await readFile(audio!.filePath, 'utf8')).toBe(hostile);
    await audio!.cleanup();
  });

  it('survives a double-quoted slot without splitting the text', async () => {
    const provider = new CliTextToSpeechProvider(
      'printf "<%s>" "{text}" > {output}',
      5_000,
      'opus'
    );

    const audio = await provider.synthesize({ text: 'one  two\tthree' });

    expect(await readFile(audio!.filePath, 'utf8')).toBe('<one  two\tthree>');
    await audio!.cleanup();
  });

  it('returns undefined when the command writes nothing', async () => {
    const provider = new CliTextToSpeechProvider('true', 5_000, 'opus');

    await expect(provider.synthesize({ text: 'hello' })).resolves.toBeUndefined();
  });
});

describe('CliTranscriptionProvider', () => {
  let dir: string;
  let marker: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ink-cli-stt-'));
    marker = path.join(dir, 'executed');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('delivers the input path and mime type to the command', async () => {
    const provider = new CliTranscriptionProvider('printf "%s|%s" {input} {mime}', 5_000);

    const transcript = await provider.transcribe({
      filePath: '/tmp/some dir/clip.ogg',
      contentType: 'audio/ogg',
    });

    expect(transcript).toBe('/tmp/some dir/clip.ogg|audio/ogg');
  });

  it('treats a hostile content type as text, not as a command', async () => {
    const provider = new CliTranscriptionProvider('printf %s {mime}', 5_000);
    const hostile = `$(printf pwned > ${marker})`;

    const transcript = await provider.transcribe({
      filePath: '/tmp/clip.ogg',
      contentType: hostile,
    });

    expect(existsSync(marker)).toBe(false);
    expect(transcript).toBe(hostile);
  });

  it('runs the shipped command-substitution template shape', async () => {
    const provider = new CliTranscriptionProvider(`printf %s "$(basename {input} .ogg)"`, 5_000);

    const transcript = await provider.transcribe({
      filePath: '/tmp/some dir/clip.ogg',
      contentType: 'audio/ogg',
    });

    expect(transcript).toBe('clip');
  });

  it('returns undefined when the command fails', async () => {
    const provider = new CliTranscriptionProvider('exit 1', 5_000);

    await expect(
      provider.transcribe({ filePath: '/tmp/clip.ogg', contentType: 'audio/ogg' })
    ).resolves.toBeUndefined();
  });
});

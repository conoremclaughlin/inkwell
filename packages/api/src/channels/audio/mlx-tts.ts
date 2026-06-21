/**
 * MLX TTS provider — on-device speech synthesis via mlx-audio.
 *
 * Default model: Qwen3-TTS 0.6B CustomVoice (Apache 2.0) through the MLX
 * community port — multilingual (incl. German), preset voices, roughly
 * real-time on Apple Silicon. Model weights download from Hugging Face
 * automatically on first synthesis.
 *
 * Availability is checked lazily PER CALL (cached with a short TTL): a
 * `pip install mlx-audio` enables this provider on the next voice reply.
 * No server restart, no env edit — same pattern as the Parakeet STT
 * provider.
 *
 * Output: mlx-audio writes WAV; when the configured format is opus/mp3
 * (Telegram voice notes want OGG/Opus), ffmpeg re-encodes. Without
 * ffmpeg the provider falls back to returning the WAV — Telegram then
 * renders an audio file instead of a voice bubble, which still works.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, rm, stat } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger';
import { contentTypeForFormat } from './audio-utils';
import type { TextToSpeechProvider, TextToSpeechInput, SynthesizedAudio } from './tts-provider';

const execFileAsync = promisify(execFile);

export const DEFAULT_MLX_TTS_MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit';
export const DEFAULT_MLX_TTS_VOICE = 'serena';

/** Python interpreters checked for an importable mlx_audio, in order. */
export function mlxPythonCandidates(): string[] {
  return [
    process.env.AUDIO_TTS_MLX_PYTHON?.trim() || '',
    'python3', // PATH
    join(homedir(), '.pyenv', 'shims', 'python3'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
  ].filter(Boolean);
}

/** ffmpeg locations checked for opus/mp3 re-encoding, in order. */
export function ffmpegCandidates(): string[] {
  return [
    process.env.FFMPEG_BIN?.trim() || '',
    'ffmpeg', // PATH
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ].filter(Boolean);
}

export interface MlxTtsProviderConfig {
  model?: string;
  voice?: string;
  format?: string;
  timeoutMs?: number;
  maxChars?: number;
  /** Grace period between SIGTERM and SIGKILL on timeout (default 5s) */
  killGraceMs?: number;
  /** Override python candidate list (tests) */
  pythonCandidates?: string[];
  /** Override ffmpeg candidate list (tests) */
  ffmpegBinCandidates?: string[];
}

export class MlxAudioTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'mlx';

  private readonly model: string;
  private readonly voice: string;
  private readonly format: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  private readonly killGraceMs: number;
  /** Resolved python path, or null when unavailable. Re-checked after TTL. */
  private resolvedPython: string | null | undefined;
  private resolvedAt = 0;
  private static readonly AVAILABILITY_TTL_MS = 60_000;

  private readonly pythonCandidates?: string[];
  private readonly ffmpegBinCandidates?: string[];

  constructor(config?: MlxTtsProviderConfig) {
    this.model = config?.model || process.env.AUDIO_TTS_MLX_MODEL?.trim() || DEFAULT_MLX_TTS_MODEL;
    this.voice = config?.voice || process.env.AUDIO_TTS_MLX_VOICE?.trim() || DEFAULT_MLX_TTS_VOICE;
    this.format = config?.format || 'opus';
    // First synthesis downloads model weights — keep generous headroom.
    this.timeoutMs = config?.timeoutMs ?? 300_000;
    this.maxChars = config?.maxChars ?? 4_000;
    this.killGraceMs = config?.killGraceMs ?? 5_000;
    this.pythonCandidates = config?.pythonCandidates;
    this.ffmpegBinCandidates = config?.ffmpegBinCandidates;
  }

  /**
   * Find a python with mlx_audio importable. Cached with a short TTL so
   * an install mid-session is picked up without restart, while
   * steady-state replies don't re-probe every time.
   */
  async resolvePython(): Promise<string | null> {
    const now = Date.now();
    if (
      this.resolvedPython !== undefined &&
      now - this.resolvedAt < MlxAudioTextToSpeechProvider.AVAILABILITY_TTL_MS
    ) {
      return this.resolvedPython;
    }
    for (const candidate of this.pythonCandidates ?? mlxPythonCandidates()) {
      try {
        await execFileAsync(candidate, ['-c', 'import mlx_audio'], { timeout: 20_000 });
        this.resolvedPython = candidate;
        this.resolvedAt = now;
        return candidate;
      } catch {
        // try next candidate
      }
    }
    this.resolvedPython = null;
    this.resolvedAt = now;
    return null;
  }

  private async resolveFfmpeg(): Promise<string | null> {
    for (const candidate of this.ffmpegBinCandidates ?? ffmpegCandidates()) {
      try {
        await execFileAsync(candidate, ['-version'], { timeout: 15_000 });
        return candidate;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  async synthesize(input: TextToSpeechInput): Promise<SynthesizedAudio | undefined> {
    const text = input.text.trim().slice(0, this.maxChars);
    if (!text) return undefined;

    const python = await this.resolvePython();
    if (!python) return undefined;

    const voice = input.voice || this.voice;
    const outputDir = await mkdtemp(join(tmpdir(), 'ink-mlx-tts-'));
    const cleanup = async () => {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
      logger.info('MLX TTS synthesizing', {
        model: this.model,
        voice,
        inputChars: text.length,
        python,
      });
      await this.runProcess(
        python,
        [
          '-m',
          'mlx_audio.tts.generate',
          '--model',
          this.model,
          '--text',
          text,
          '--voice',
          voice,
          '--output_path',
          outputDir,
          '--file_prefix',
          'reply',
          '--audio_format',
          'wav',
          '--join_audio',
        ],
        this.timeoutMs
      );

      const wavPath = await this.findOutputFile(outputDir, '.wav');
      if (!wavPath) throw new Error('mlx-audio produced no wav output');

      // Telegram voice bubbles want OGG/Opus — re-encode when possible.
      // Any encode problem (no ffmpeg, or ffmpeg fails mid-encode) falls
      // through to returning the WAV we already have — synthesized speech
      // must never be discarded over a re-encode failure.
      if (this.format === 'opus' || this.format === 'mp3') {
        const ffmpeg = await this.resolveFfmpeg();
        if (ffmpeg) {
          try {
            const encoded = await this.encode(ffmpeg, wavPath, outputDir, this.format);
            return {
              filePath: encoded.path,
              contentType: contentTypeForFormat(this.format),
              filename: encoded.filename,
              cleanup,
            };
          } catch (error) {
            logger.warn('MLX TTS: ffmpeg encode failed, returning wav instead', {
              requestedFormat: this.format,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          logger.warn('MLX TTS: ffmpeg unavailable, returning wav instead of requested format', {
            requestedFormat: this.format,
          });
        }
      }

      return {
        filePath: wavPath,
        contentType: contentTypeForFormat('wav'),
        filename: 'reply.wav',
        cleanup,
      };
    } catch (error) {
      await cleanup();
      logger.warn('MLX TTS synthesis failed', {
        model: this.model,
        voice: this.voice,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private runProcess(bin: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // detached → own process group, so a timeout kill reaches any
      // descendants the python process spawned, not just the shell/python
      // itself.
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const signalGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal); // whole process group
        } catch {
          child.kill(signal); // group already gone — best effort
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        // Escalate: a TERM-ignoring child must not outlive synthesize().
        killTimer = setTimeout(() => signalGroup('SIGKILL'), this.killGraceMs);
      }, timeoutMs);
      // Settle ONLY on close — guarantees the process is actually dead
      // (not merely signalled) by the time the promise resolves/rejects.
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (timedOut) reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
        else if (code === 0) resolve();
        else reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 300)}`));
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(err);
      });
    });
  }

  /** Find the largest generated file with the given extension (mlx-audio
   *  may name segments reply.wav / reply_000.wav depending on model). */
  private async findOutputFile(dir: string, extension: string): Promise<string | undefined> {
    const entries = await readdir(dir);
    const matches = entries.filter((name) => name.startsWith('reply') && name.endsWith(extension));
    if (matches.length === 0) return undefined;
    let best: { path: string; size: number } | undefined;
    for (const name of matches) {
      const filePath = join(dir, name);
      const details = await stat(filePath).catch(() => undefined);
      if (!details?.isFile()) continue;
      if (!best || details.size > best.size) {
        best = { path: filePath, size: details.size };
      }
    }
    return best && best.size > 0 ? best.path : undefined;
  }

  private async encode(
    ffmpeg: string,
    wavPath: string,
    outputDir: string,
    format: string
  ): Promise<{ path: string; filename: string }> {
    const isOpus = format === 'opus';
    const filename = isOpus ? 'reply.ogg' : 'reply.mp3';
    const outPath = join(outputDir, filename);
    const args = isOpus
      ? ['-y', '-i', wavPath, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', outPath]
      : ['-y', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '64k', outPath];
    await this.runProcess(ffmpeg, args, 60_000);
    const details = await stat(outPath).catch(() => undefined);
    if (!details || details.size <= 0) {
      throw new Error(`ffmpeg produced no ${format} output`);
    }
    return { path: outPath, filename };
  }
}

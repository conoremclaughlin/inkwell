/**
 * Parakeet STT provider — on-device transcription via parakeet-mlx.
 *
 * NVIDIA's parakeet-tdt-0.6b-v3 through the MLX port (Apple Silicon):
 * ~2-3s per voice note, automatic language detection, strong on European
 * languages, fully offline. Model weights (~600MB) download from Hugging
 * Face automatically on first transcription.
 *
 * Availability is checked lazily PER CALL (cached): the binary appearing
 * on the machine — e.g. installed by the setup_audio_transcription MCP
 * tool after the user consents — enables this provider on the very next
 * voice note. No server restart, no env edit.
 */

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join, basename } from 'path';
import { logger } from '../../utils/logger';
import type { AudioTranscriptionProvider, AudioTranscriptionInput } from './stt-provider';

const execFileAsync = promisify(execFile);

export const DEFAULT_PARAKEET_MODEL = 'mlx-community/parakeet-tdt-0.6b-v3';

/** Locations checked for the parakeet-mlx binary, in order. */
export function parakeetBinaryCandidates(): string[] {
  return [
    process.env.AUDIO_TRANSCRIPTION_PARAKEET_BIN?.trim() || '',
    'parakeet-mlx', // PATH
    join(homedir(), '.pyenv', 'shims', 'parakeet-mlx'),
    '/opt/homebrew/bin/parakeet-mlx',
    '/usr/local/bin/parakeet-mlx',
  ].filter(Boolean);
}

export interface ParakeetProviderConfig {
  model?: string;
  timeoutMs?: number;
  /** Override binary candidate list (tests) */
  binaryCandidates?: string[];
}

export class ParakeetTranscriptionProvider implements AudioTranscriptionProvider {
  readonly name = 'parakeet';

  private readonly model: string;
  private readonly timeoutMs: number;
  /** Resolved binary path, or null when unavailable. Re-checked after TTL. */
  private resolvedBin: string | null | undefined;
  private resolvedAt = 0;
  private static readonly AVAILABILITY_TTL_MS = 60_000;

  private readonly binaryCandidates?: string[];

  constructor(config?: ParakeetProviderConfig) {
    this.model =
      config?.model ||
      process.env.AUDIO_TRANSCRIPTION_PARAKEET_MODEL?.trim() ||
      DEFAULT_PARAKEET_MODEL;
    this.timeoutMs = config?.timeoutMs ?? 180_000;
    this.binaryCandidates = config?.binaryCandidates;
  }

  /**
   * Find a working parakeet-mlx binary. Cached with a short TTL so an
   * install mid-session is picked up without restart, while steady-state
   * voice notes don't re-probe every time.
   */
  async resolveBinary(): Promise<string | null> {
    const now = Date.now();
    if (
      this.resolvedBin !== undefined &&
      now - this.resolvedAt < ParakeetTranscriptionProvider.AVAILABILITY_TTL_MS
    ) {
      return this.resolvedBin;
    }
    for (const candidate of this.binaryCandidates ?? parakeetBinaryCandidates()) {
      try {
        await execFileAsync(candidate, ['--help'], { timeout: 15_000 });
        this.resolvedBin = candidate;
        this.resolvedAt = now;
        return candidate;
      } catch {
        // try next candidate
      }
    }
    this.resolvedBin = null;
    this.resolvedAt = now;
    return null;
  }

  async transcribe(input: AudioTranscriptionInput): Promise<string | undefined> {
    const bin = await this.resolveBinary();
    if (!bin) return undefined;

    const outputDir = await mkdtemp(join(tmpdir(), 'ink-parakeet-'));
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          bin,
          [
            input.filePath,
            '--model',
            this.model,
            '--output-format',
            'txt',
            '--output-dir',
            outputDir,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`parakeet-mlx timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(new Error(`parakeet-mlx exited ${code}: ${stderr.slice(0, 300)}`));
        });
        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const base = basename(input.filePath).replace(/\.[^.]*$/, '');
      const transcript = await readFile(join(outputDir, `${base}.txt`), 'utf-8');
      return transcript.trim() || undefined;
    } catch (error) {
      logger.warn('Parakeet transcription failed', {
        filePath: input.filePath,
        model: this.model,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

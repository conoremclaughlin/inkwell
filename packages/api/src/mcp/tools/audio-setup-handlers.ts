/**
 * setup_audio_transcription — consent-driven on-device STT setup.
 *
 * The flow this enables: a user sends a voice note → no transcription
 * provider is available → the InboundMediaPipeline injects a hint → the
 * SB asks the user whether to set up local transcription → on consent,
 * the SB calls this tool with action "install".
 *
 *   status  — report platform support, binary availability, configured
 *             providers, and whether the model is warm
 *   install — pip-install parakeet-mlx (Apple Silicon only) and warm the
 *             model with a generated silent clip (~600MB one-time
 *             download from Hugging Face). Long-running: up to ~5 min on
 *             first install.
 *
 * The Parakeet provider checks binary availability lazily per call, so a
 * successful install enables transcription on the NEXT voice note — no
 * server restart required.
 */

import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger';
import {
  ParakeetTranscriptionProvider,
  parakeetBinaryCandidates,
  DEFAULT_PARAKEET_MODEL,
} from '../../channels/audio';

const execFileAsync = promisify(execFile);

export const setupAudioTranscriptionSchema = z.object({
  action: z
    .enum(['status', 'install'])
    .describe(
      'status: report platform support + provider availability. install: pip-install parakeet-mlx and warm the model (requires prior user consent — ~600MB one-time download).'
    ),
});

const PIP_CANDIDATES = ['pip3', 'pip'];

async function findPip(): Promise<string | null> {
  for (const pip of PIP_CANDIDATES) {
    try {
      await execFileAsync(pip, ['--version'], { timeout: 15_000 });
      return pip;
    } catch {
      // try next
    }
  }
  return null;
}

function platformSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/**
 * 0.5s of silence as a 16kHz mono WAV — enough to trigger the model
 * download/warmup without needing ffmpeg or fixture files on disk.
 */
function silentWavBytes(): Buffer {
  const sampleRate = 16_000;
  const samples = sampleRate / 2;
  const dataSize = samples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // samples are already zero-initialized = silence
  return buffer;
}

async function getStatus() {
  const provider = new ParakeetTranscriptionProvider();
  const bin = await provider.resolveBinary();
  const pip = await findPip();
  return {
    success: true,
    platformSupported: platformSupported(),
    platform: `${process.platform}/${process.arch}`,
    parakeetInstalled: Boolean(bin),
    parakeetBinary: bin,
    binaryCandidates: parakeetBinaryCandidates(),
    pipAvailable: Boolean(pip),
    model: process.env.AUDIO_TRANSCRIPTION_MODEL_PARAKEET || DEFAULT_PARAKEET_MODEL,
    transcriptionEnabledEnv: process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false',
    openaiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    note: bin
      ? 'Parakeet is installed — voice notes transcribe on-device automatically.'
      : platformSupported()
        ? 'Parakeet is not installed. With user consent, call setup_audio_transcription(action: "install").'
        : 'This platform is not Apple Silicon — parakeet-mlx is unavailable. Configure OPENAI_API_KEY or AUDIO_TRANSCRIPTION_CLI_COMMAND instead.',
  };
}

async function runInstall() {
  if (!platformSupported()) {
    return {
      success: false,
      error: `parakeet-mlx requires Apple Silicon (this machine: ${process.platform}/${process.arch}). Configure OPENAI_API_KEY or AUDIO_TRANSCRIPTION_CLI_COMMAND instead.`,
    };
  }

  const provider = new ParakeetTranscriptionProvider();
  const existing = await provider.resolveBinary();
  const steps: string[] = [];

  if (existing) {
    steps.push(`parakeet-mlx already installed at ${existing}`);
  } else {
    const pip = await findPip();
    if (!pip) {
      return {
        success: false,
        error: 'No pip/pip3 found on PATH — install Python 3.10+ first.',
        steps,
      };
    }
    logger.info('Installing parakeet-mlx via pip', { pip });
    try {
      await execFileAsync(pip, ['install', '--quiet', 'parakeet-mlx'], {
        timeout: 240_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      steps.push(`installed parakeet-mlx via ${pip}`);
    } catch (error) {
      return {
        success: false,
        error: `pip install failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
        steps,
      };
    }
  }

  // Warm the model: first transcription pulls ~600MB of weights from
  // Hugging Face. A generated silent clip keeps this self-contained.
  const warmDir = await mkdtemp(join(tmpdir(), 'ink-parakeet-warm-'));
  try {
    const wavPath = join(warmDir, 'silence.wav');
    await writeFile(wavPath, silentWavBytes());
    const warmStart = Date.now();
    await new ParakeetTranscriptionProvider({ timeoutMs: 600_000 }).transcribe({
      filePath: wavPath,
      contentType: 'audio/wav',
      filename: 'silence.wav',
    });
    steps.push(`model warm (${Math.round((Date.now() - warmStart) / 1000)}s)`);
  } catch (error) {
    steps.push(
      `model warmup skipped: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`
    );
  } finally {
    await rm(warmDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const bin = await new ParakeetTranscriptionProvider().resolveBinary();
  return {
    success: Boolean(bin),
    binary: bin,
    model: DEFAULT_PARAKEET_MODEL,
    steps,
    note: bin
      ? 'On-device transcription is live — the next voice note will be transcribed automatically (no restart needed).'
      : 'Install completed but the binary could not be resolved — check PATH/pyenv shims.',
  };
}

export async function handleSetupAudioTranscription(args: unknown) {
  const { action } = setupAudioTranscriptionSchema.parse(args);
  return action === 'status' ? getStatus() : runInstall();
}

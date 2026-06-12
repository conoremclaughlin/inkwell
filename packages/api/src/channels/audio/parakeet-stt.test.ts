import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ParakeetTranscriptionProvider, parakeetBinaryCandidates } from './parakeet-stt.js';

describe('parakeetBinaryCandidates', () => {
  it('puts the env override first when set', () => {
    process.env.AUDIO_TRANSCRIPTION_PARAKEET_BIN = '/custom/parakeet';
    try {
      const candidates = parakeetBinaryCandidates();
      expect(candidates[0]).toBe('/custom/parakeet');
      expect(candidates).toContain('parakeet-mlx');
    } finally {
      delete process.env.AUDIO_TRANSCRIPTION_PARAKEET_BIN;
    }
  });

  it('omits the override slot when unset', () => {
    delete process.env.AUDIO_TRANSCRIPTION_PARAKEET_BIN;
    expect(parakeetBinaryCandidates()[0]).toBe('parakeet-mlx');
  });
});

describe('ParakeetTranscriptionProvider', () => {
  let dir: string;
  let fakeBin: string;
  let audioPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'parakeet-test-'));
    audioPath = join(dir, 'voice-note.ogg');
    await writeFile(audioPath, Buffer.alloc(128, 1));

    // A fake parakeet-mlx: answers --help, and on transcribe writes
    // <basename>.txt into the --output-dir like the real CLI does.
    fakeBin = join(dir, 'fake-parakeet');
    await writeFile(
      fakeBin,
      `#!/bin/sh
if [ "$1" = "--help" ]; then echo usage; exit 0; fi
input="$1"
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-dir" ]; then outdir="$arg"; fi
  prev="$arg"
done
base=$(basename "$input")
echo "fake transcript of $base" > "$outdir/\${base%.*}.txt"
`
    );
    await chmod(fakeBin, 0o755);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('transcribes via the resolved binary and reads the txt output', async () => {
    const provider = new ParakeetTranscriptionProvider({ binaryCandidates: [fakeBin] });
    const transcript = await provider.transcribe({
      filePath: audioPath,
      contentType: 'audio/ogg',
    });
    expect(transcript).toBe('fake transcript of voice-note.ogg');
  });

  it('self-disables (returns undefined) when no binary is available', async () => {
    const provider = new ParakeetTranscriptionProvider({
      binaryCandidates: ['/nonexistent/parakeet-mlx'],
    });
    const transcript = await provider.transcribe({ filePath: audioPath });
    expect(transcript).toBeUndefined();
  });

  it('caches binary resolution within the TTL', async () => {
    const provider = new ParakeetTranscriptionProvider({ binaryCandidates: [fakeBin] });
    const first = await provider.resolveBinary();
    const second = await provider.resolveBinary();
    expect(first).toBe(fakeBin);
    expect(second).toBe(fakeBin);
  });

  it('returns undefined (not a throw) when the binary fails on the file', async () => {
    const brokenBin = join(dir, 'broken-parakeet');
    await writeFile(brokenBin, '#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\nexit 3\n');
    await chmod(brokenBin, 0o755);
    const provider = new ParakeetTranscriptionProvider({ binaryCandidates: [brokenBin] });
    const transcript = await provider.transcribe({ filePath: audioPath });
    expect(transcript).toBeUndefined();
  });
});

/**
 * Baileys runtime smoke test — NOT mocked.
 *
 * Both production call sites (whatsapp-auth.ts, whatsapp-listener.ts) reach
 * Baileys through `await import('@whiskeysockets/baileys')`. A dynamic import
 * is invisible to type-check and to every mocked test in the suite, so a
 * dependency tree that cannot load Baileys at all still leaves the suite green.
 * That is exactly what happened on PR #633: a root `resolutions` entry pinning
 * `libsignal` to npm:2.0.1 force-downgraded the `npm:^6.0.0` that Baileys
 * 7.0.0-rc14 declares, and `import { PreKeyWhisperMessage }` threw
 * `SyntaxError: Named export not found` on the first connect — with 6815 tests
 * passing.
 *
 * These tests load the real package and assert the exact bindings production
 * destructures. No network and no WhatsApp account is involved.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('baileys runtime contract (unmocked)', () => {
  it('loads the real package', async () => {
    // Fails outright when libsignal is force-downgraded away from what
    // Baileys declares: the SyntaxError is raised while linking the module.
    const baileys = await import('@whiskeysockets/baileys');
    expect(baileys).toBeDefined();
  });

  it('exposes every binding whatsapp-listener.ts destructures', async () => {
    const {
      makeWASocket,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
    } = await import('@whiskeysockets/baileys');

    expect(makeWASocket).toBeTypeOf('function');
    expect(fetchLatestBaileysVersion).toBeTypeOf('function');
    expect(makeCacheableSignalKeyStore).toBeTypeOf('function');
    expect(DisconnectReason).toBeDefined();
  });

  it('exposes the binding whatsapp-auth.ts destructures', async () => {
    const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    expect(useMultiFileAuthState).toBeTypeOf('function');
  });

  it("resolves the named libsignal export under Node's own ESM loader", async () => {
    // The precise import that broke: Baileys' lib/Signal/libsignal.js does
    // `import { PreKeyWhisperMessage } from 'libsignal/src/protobufs.js'`.
    //
    // This runs in a subprocess on purpose. Vitest's CJS interop populates the
    // namespace object more generously than Node's native ESM linker does, so
    // asserting on `await import(...)` from inside the test passes even with
    // libsignal 2.0.1 installed — it never reaches the failing path. Production
    // is plain `node`, so the static named import has to be checked there.
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);

    const { stdout } = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { PreKeyWhisperMessage } from 'libsignal/src/protobufs.js';" +
          "if (typeof PreKeyWhisperMessage === 'undefined') throw new Error('binding undefined');" +
          "console.log('NAMED_EXPORT_OK');",
      ],
      { cwd: path.resolve(__dirname, '../..') }
    );

    expect(stdout).toContain('NAMED_EXPORT_OK');
  });

  it('initialises real signal auth state against a temp dir', async () => {
    // Exercises credential generation through libsignal's curve25519 rather
    // than just module load. Uses a throwaway dir — never the real
    // ~/.ink/credentials/whatsapp tree, which holds live account creds.
    const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'baileys-smoke-'));

    try {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      expect(state.creds).toBeDefined();
      expect(saveCreds).toBeTypeOf('function');

      // Signal identity material is what libsignal actually produces.
      expect(state.creds.signedIdentityKey?.public).toBeInstanceOf(Uint8Array);
      expect(state.creds.signedPreKey?.keyPair?.public).toBeInstanceOf(Uint8Array);
      expect(state.creds.registrationId).toBeTypeOf('number');
    } finally {
      await fs.rm(authDir, { recursive: true, force: true });
    }
  });
});

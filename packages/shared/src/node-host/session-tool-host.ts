/** The session's real coding/media/credential effects; callers still supply policy and admission. */
import { isAbsolute, join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { resolveCredentialRefs } from '../runtime/credential-resolver.js';
import type { LocalToolDispatchDeps } from '../runtime/tool-dispatch.js';
import { createCodingToolHost, type CodingToolHostPorts } from './coding-tools.js';
import { createToolImageCapture } from './tool-images.js';
import { viewImage } from './view-image.js';
import { SessionMediaStore } from './session-media-store.js';
import type { ContextLedger } from '../runtime/context-ledger.js';
import type { ContextImage } from '../runtime/context-image.js';

export function createSessionToolHost(input: {
  cwd: string;
  home: string;
  imageRoots: readonly string[];
  tempDir: string;
  credentials: Readonly<Record<string, string>>;
  coding: CodingToolHostPorts;
  /** Bind only after the canonical log is selected. Absent means ephemeral-only. */
  logPath?: string;
  mediaLimits?: { maxFiles?: number; maxBytes?: number };
}) {
  for (const path of [input.cwd, input.home, input.tempDir, ...input.imageRoots]) {
    if (!isAbsolute(path)) throw new Error('Session tool host paths must be absolute');
  }
  const { cwd, home, tempDir } = input;
  const roots = [...input.imageRoots];
  const credentials = { ...input.credentials };
  const coding = createCodingToolHost(cwd, input.coding);
  const images = createToolImageCapture();
  const media = input.logPath
    ? new SessionMediaStore({ logPath: input.logPath, ...input.mediaLimits })
    : undefined;
  let cache: Promise<string> | undefined;
  let closed = false;
  const requireOpen = () => {
    if (closed) throw new Error('Session tool host is closed');
  };
  const requireCwd = (requested: string) => {
    requireOpen();
    if (requested !== cwd) throw new Error('A session tool host cannot change working directory');
  };
  const dispatch: Pick<
    LocalToolDispatchDeps,
    'loadCodingTools' | 'callPi' | 'viewImage' | 'resolveCredentials'
  > = {
    loadCodingTools: async (requested) => {
      requireCwd(requested);
      return coding.tools();
    },
    callPi: async (tool, args, requested, signal) => {
      requireCwd(requested);
      return coding.call(tool, args, signal);
    },
    viewImage: async (args, requested, signal) => {
      requireCwd(requested);
      return viewImage(args, { cwd, home, roots, signal, readImage: coding.readImage });
    },
    resolveCredentials: (args) => {
      requireOpen();
      return resolveCredentialRefs(args, credentials).args;
    },
  };
  return {
    dispatch,
    images,
    async retainImage(bytes: Buffer): Promise<ContextImage | undefined> {
      requireOpen();
      const result = await media?.put(bytes);
      return result?.ok ? { ...result.image, retained: result.descriptor } : undefined;
    },
    async restoreLedgerImages(ledger: ContextLedger, signal?: AbortSignal): Promise<void> {
      requireOpen();
      for (const entry of ledger.listEntries()) {
        if (!entry.media?.length) continue;
        const restored: ContextImage[] = [];
        const notes: string[] = [];
        for (const image of entry.media) {
          signal?.throwIfAborted();
          const result = image.retained && (await media?.restore(image.retained));
          signal?.throwIfAborted();
          if (result && result.ok) restored.push({ ...result.image, retained: result.descriptor });
          else
            notes.push(
              `[${image.ref} unavailable: an image was here, but its retained bytes could not be verified or were not retained; it has not been reattached to this context]`
            );
        }
        ledger.restoreEntryImages(entry.id, restored, notes);
      }
    },
    cacheDir: () => {
      requireOpen();
      cache ??= mkdtemp(join(tempDir, 'ink-tool-images-'));
      return cache;
    },
    /** Call only after the host has stopped and awaited all dispatches/clones. */
    async close() {
      closed = true;
      for (const name of Object.keys(credentials)) delete credentials[name];
      await media?.close();
      if (cache) await rm(await cache, { recursive: true, force: true });
    },
  };
}

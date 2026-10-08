/** The session's real coding/media/credential effects; callers still supply policy and admission. */
import { isAbsolute, join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { resolveCredentialRefs } from '../runtime/credential-resolver.js';
import type { LocalToolDispatchDeps } from '../runtime/tool-dispatch.js';
import { createCodingToolHost, type CodingToolHostPorts } from './coding-tools.js';
import { createToolImageCapture } from './tool-images.js';
import { viewImage } from './view-image.js';

export function createSessionToolHost(input: {
  cwd: string;
  home: string;
  imageRoots: readonly string[];
  tempDir: string;
  credentials: Readonly<Record<string, string>>;
  coding: CodingToolHostPorts;
}) {
  for (const path of [input.cwd, input.home, input.tempDir, ...input.imageRoots]) {
    if (!isAbsolute(path)) throw new Error('Session tool host paths must be absolute');
  }
  const { cwd, home, tempDir } = input;
  const roots = [...input.imageRoots];
  const credentials = { ...input.credentials };
  const coding = createCodingToolHost(cwd, input.coding);
  const images = createToolImageCapture();
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
    cacheDir: () => {
      requireOpen();
      cache ??= mkdtemp(join(tempDir, 'ink-tool-images-'));
      return cache;
    },
    /** Call only after the host has stopped and awaited all dispatches/clones. */
    async close() {
      closed = true;
      for (const name of Object.keys(credentials)) delete credentials[name];
      if (cache) await rm(await cache, { recursive: true, force: true });
    },
  };
}

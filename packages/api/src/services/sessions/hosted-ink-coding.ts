/** The existing Pi tools with async file effects and per-call process ownership. */
import { access, mkdir, open, opendir, stat, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { basename, isAbsolute, resolve } from 'path';
import {
  createToolProcesses,
  type CodingTool,
  type CodingToolHostPorts,
} from '@inklabs/shared/node-host';
import { extractPdfText } from '@inklabs/shared/providers';
import type { InkToolCallResult } from '@inklabs/shared/runtime';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

async function readBounded(path: string, maxBytes: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('Tool file exceeds its byte bound or is not a regular file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > maxBytes) throw new Error('Tool file exceeds its byte bound');
    signal.throwIfAborted();
    return buffer.subarray(0, used);
  } finally {
    await file.close();
  }
}

/** Explicit absolute paths mean Pi never resolves ~ against the API's ambient home. */
function toolPath(path: string, cwd: string) {
  if (path.startsWith('~') || path.startsWith('@'))
    throw new Error('Hosted coding paths must be absolute or relative to the session directory');
  return resolve(cwd, path);
}

export async function createHostedInkCoding(input: {
  cwd: string;
  tempDir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  shell: string;
  resolveBinary(name: 'rg' | 'fd'): Promise<string>;
  signal: AbortSignal;
}) {
  for (const path of [input.cwd, input.tempDir, input.shell])
    if (!isAbsolute(path)) throw new Error('Hosted coding host paths must be absolute');
  input.signal.throwIfAborted();
  const pi = await import('@mariozechner/pi-coding-agent');
  // Allowlist execution plumbing, never the API's database/signing/provider secrets.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot'])
    if (input.env[key] !== undefined) env[key] = input.env[key];
  env.TMPDIR = input.tempDir;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const own = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise)
    );
    return promise;
  };
  const call = async (
    name: string,
    id: string,
    original: Record<string, unknown>,
    signal?: AbortSignal
  ) => {
    const stop = AbortSignal.any([
      input.signal,
      lifetime.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(120_000),
    ]);
    stop.throwIfAborted();
    const args = { ...original };
    if (typeof args.path === 'string') args.path = toolPath(args.path, input.cwd);
    if (name === 'edit') {
      if (
        Buffer.byteLength(JSON.stringify(args)) > MAX_EDIT_BYTES ||
        !Array.isArray(args.edits) ||
        args.edits.length > 64
      )
        throw new Error('Hosted edit exceeds its bounded batch; split the edit');
    }
    if (
      name === 'edit' &&
      (args.edits as unknown[]).some((item) => {
        if (!item || typeof item !== 'object') return true;
        const edit = item as Record<string, unknown>;
        return typeof edit.newText !== 'string' || edit.newText.split('\n').length > 2000;
      })
    )
      throw new Error('Hosted edit replacement exceeds its line bound');
    if (
      name === 'write' &&
      (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE_BYTES)
    )
      throw new Error('Hosted write exceeds its byte bound');
    if (
      name === 'grep' &&
      typeof args.context === 'number' &&
      (!Number.isSafeInteger(args.context) || args.context < 0 || args.context > 50)
    )
      throw new Error('Hosted grep context must be an integer between 0 and 50');
    if (
      typeof args.limit === 'number' &&
      (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 2000)
    )
      throw new Error('Hosted tool limit must be an integer between 1 and 2000');
    const processes = createToolProcesses({
      cwd: input.cwd,
      env,
      signal: stop,
      timeoutMs: 120_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    const effects: Promise<unknown>[] = [];
    const effect = <T>(fn: () => Promise<T>) => {
      stop.throwIfAborted();
      const promise = fn();
      effects.push(promise);
      return promise;
    };
    const read = (path: string, bound = MAX_FILE_BYTES) =>
      effect(() => readBounded(path, bound, stop));
    const write = (path: string, content: string) =>
      effect(async () => {
        if (Buffer.byteLength(content) > MAX_FILE_BYTES)
          throw new Error('Tool write exceeds its byte bound');
        await writeFile(path, content, { signal: stop });
      });
    const exists = async (path: string) => {
      try {
        await effect(() => access(path));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const search = (name: 'rg' | 'fd') => ({
      resolveCommand: async () => {
        const path = await input.resolveBinary(name);
        stop.throwIfAborted();
        return path;
      },
      spawnProcess: (file: string, args: readonly string[]) => processes.spawn(file, args),
    });
    try {
      const factories: Record<string, () => unknown> = {
        read: () =>
          pi.createReadTool(input.cwd, {
            resolvePath: async (path) => toolPath(path, input.cwd),
            autoResizeImages: false,
            operations: {
              readFile: (path) => read(path),
              access: (path) => effect(() => access(path, constants.R_OK)),
              detectImageMimeType: async (path) => {
                const bytes = await read(path);
                if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
                  return 'image/png';
                if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
                if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
                if (
                  bytes.subarray(0, 4).toString() === 'RIFF' &&
                  bytes.subarray(8, 12).toString() === 'WEBP'
                )
                  return 'image/webp';
                return null;
              },
            },
          }),
        edit: () =>
          pi.createEditTool(input.cwd, {
            operations: {
              access: (path) => effect(() => access(path, constants.R_OK | constants.W_OK)),
              readFile: async (path) => {
                const bytes = await read(path, MAX_EDIT_BYTES);
                if (bytes.toString().split('\n').length > 2000)
                  throw new Error(
                    'Hosted edit has too many lines; use smaller files or a shell tool'
                  );
                return bytes;
              },
              writeFile: write,
            },
          }),
        write: () =>
          pi.createWriteTool(input.cwd, {
            operations: {
              writeFile: write,
              mkdir: (path) =>
                effect(async () => {
                  await mkdir(path, { recursive: true });
                }),
            },
          }),
        ls: () =>
          pi.createLsTool(input.cwd, {
            operations: {
              exists,
              stat: (path) => effect(() => stat(path)),
              readdir: (path) =>
                effect(async () => {
                  const entries: string[] = [];
                  for await (const entry of await opendir(path)) {
                    stop.throwIfAborted();
                    if (entries.length >= 20_000)
                      throw new Error('Directory exceeds its entry bound; narrow the listing');
                    entries.push(entry.name);
                  }
                  return entries;
                }),
            },
          }),
        grep: () =>
          pi.createGrepTool(input.cwd, {
            ...search('rg'),
            operations: {
              isDirectory: (path) => effect(async () => (await stat(path)).isDirectory()),
              readFile: async (path) => (await read(path)).toString('utf8'),
            },
          }),
        find: () => pi.createFindTool(input.cwd, search('fd')),
        bash: () =>
          pi.createBashTool(input.cwd, {
            env,
            tempDirectory: input.tempDir,
            operations: {
              exec: async (command, cwd, options) => {
                if (cwd !== input.cwd) throw new Error('Shell changed its session directory');
                stop.throwIfAborted();
                const child = processes.spawn(input.shell, ['-c', command]);
                child.stdout.on('data', options.onData);
                child.stderr.on('data', options.onData);
                const timeout =
                  typeof options.timeout === 'number' && options.timeout > 0
                    ? setTimeout(
                        () => processes.stop(new Error('Shell timeout exceeded')),
                        Math.min(120, options.timeout) * 1000
                      )
                    : undefined;
                try {
                  const exitCode = await new Promise<number | null>((resolve, reject) => {
                    child.once('error', reject);
                    child.once('close', resolve);
                  });
                  processes.check();
                  if (exitCode === null) throw new Error('Shell stopped before a normal exit');
                  return { exitCode };
                } finally {
                  if (timeout) clearTimeout(timeout);
                }
              },
            },
          }),
      };
      const tool = factories[name]?.() as CodingTool | undefined;
      if (!tool) throw new Error(`Unknown hosted coding tool: ${name}`);
      const result = await tool.execute(id, args, stop);
      processes.check();
      return result;
    } finally {
      await Promise.allSettled(effects);
      await processes.close();
    }
  };
  const templates = [
    pi.createReadTool(input.cwd),
    pi.createEditTool(input.cwd),
    pi.createWriteTool(input.cwd),
    pi.createBashTool(input.cwd),
    pi.createGrepTool(input.cwd),
    pi.createFindTool(input.cwd),
    pi.createLsTool(input.cwd),
  ];
  const tools: ReadonlyMap<string, CodingTool> = new Map(
    templates.map((tool) => [
      tool.name,
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: (id, args, signal) => own(call(tool.name, id, args, signal)),
      },
    ])
  );
  const ports: CodingToolHostPorts = {
    load: async (cwd) => {
      if (cwd !== input.cwd) throw new Error('Coding host cannot change directories');
      return tools;
    },
    readDocument: async (path, cwd, signal): Promise<InkToolCallResult | null> => {
      if (!path.toLowerCase().endsWith('.pdf')) return null;
      const stop = AbortSignal.any([input.signal, lifetime.signal, ...(signal ? [signal] : [])]);
      return own(
        (async () => {
          const bytes = await readBounded(toolPath(path, cwd), MAX_FILE_BYTES, stop);
          const pdf = await extractPdfText(bytes, 20);
          stop.throwIfAborted();
          if (!pdf) throw new Error('Could not extract this PDF within the tool bounds');
          const text = `[PDF: ${basename(path)} — ${pdf.pages} pages]\n\n${pdf.text}`;
          return { success: true, text, content: [{ type: 'text', text }] };
        })()
      );
    },
  };
  return {
    ports,
    async close() {
      lifetime.abort();
      await Promise.allSettled(pending);
    },
  };
}

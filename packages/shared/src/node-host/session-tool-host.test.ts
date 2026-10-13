import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSessionToolHost } from './session-tool-host.js';
import type { CodingTool, CodingToolHostPorts } from './coding-tools.js';
import { createLocalToolDispatcher } from '../runtime/tool-dispatch.js';

let root: string;
const hosts: ReturnType<typeof createSessionToolHost>[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'session-tools-')));
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await rm(root, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const textTool = (execute: CodingTool['execute']): CodingTool => ({
  name: 'read',
  description: 'fixture read',
  parameters: {},
  execute,
});
async function make(
  name: string,
  coding: CodingToolHostPorts,
  credentials = { EXAMPLE_KEY: name }
) {
  const cwd = join(root, name);
  await mkdir(cwd);
  const host = createSessionToolHost({
    cwd,
    home: root,
    imageRoots: [cwd],
    tempDir: root,
    credentials,
    coding,
  });
  hosts.push(host);
  return { host, cwd };
}
const noDocument = async () => null;

describe('session-owned coding, images and credential effects', () => {
  it('overlapping preparations cannot swap directories or credential snapshots', async () => {
    const a = deferred<ReadonlyMap<string, CodingTool>>();
    const b = deferred<ReadonlyMap<string, CodingTool>>();
    const loadA = vi.fn(() => a.promise);
    const loadB = vi.fn(() => b.promise);
    const secrets = { EXAMPLE_KEY: 'synthetic-first' };
    const first = await make('first', { load: loadA, readDocument: noDocument }, secrets);
    secrets.EXAMPLE_KEY = 'synthetic-second';
    const second = await make('second', { load: loadB, readDocument: noDocument }, secrets);
    const callsA = first.host.dispatch.callPi('read', { path: 'a.txt' }, first.cwd);
    const callsB = second.host.dispatch.callPi('read', { path: 'b.txt' }, second.cwd);
    b.resolve(
      new Map([
        [
          'read',
          textTool(async (_id, args) => ({
            content: [{ type: 'text', text: `second:${args.path}` }],
          })),
        ],
      ])
    );
    expect(await callsB).toMatchObject({ text: 'second:b.txt' });
    a.resolve(
      new Map([
        [
          'read',
          textTool(async (_id, args) => ({
            content: [{ type: 'text', text: `first:${args.path}` }],
          })),
        ],
      ])
    );
    expect(await callsA).toMatchObject({ text: 'first:a.txt' });
    expect(loadA).toHaveBeenCalledExactlyOnceWith(first.cwd);
    expect(loadB).toHaveBeenCalledExactlyOnceWith(second.cwd);
    const args = { key: '$EXAMPLE_KEY', prose: 'use $EXAMPLE_KEY', ambient: '$HOME' };
    expect(first.host.dispatch.resolveCredentials(args)).toEqual({
      key: 'synthetic-first',
      prose: args.prose,
      ambient: '$HOME',
    });
    expect(second.host.dispatch.resolveCredentials(args).key).toBe('synthetic-second');
    expect(args.key).toBe('$EXAMPLE_KEY');
  });

  it('shares one lazy preparation within a host, retries a failed preparation, and forwards Stop', async () => {
    const execute = vi.fn<CodingTool['execute']>(async () => ({
      content: [{ type: 'text', text: 'synthetic' }],
    }));
    const load = vi
      .fn<CodingToolHostPorts['load']>()
      .mockRejectedValueOnce(new Error('fixture preparation failure'))
      .mockResolvedValue(new Map([['read', textTool(execute)]]));
    const { host, cwd } = await make('retry', { load, readDocument: noDocument });
    await expect(host.dispatch.loadCodingTools(cwd)).rejects.toThrow('fixture preparation failure');
    const [one, two] = await Promise.all([
      host.dispatch.loadCodingTools(cwd),
      host.dispatch.loadCodingTools(cwd),
    ]);
    expect(one).toBe(two);
    expect(load).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    await host.dispatch.callPi('read', { path: 'file' }, cwd, controller.signal);
    expect(execute.mock.calls[0]?.[2]).toBe(controller.signal);
    controller.abort();
    await expect(
      host.dispatch.callPi('read', { path: 'file' }, cwd, controller.signal)
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute when Stop arrives while preparing tools', async () => {
    const gate = deferred<ReadonlyMap<string, CodingTool>>();
    const execute = vi.fn<CodingTool['execute']>();
    const readDocument = vi.fn(noDocument);
    const { host, cwd } = await make('cancel', {
      load: () => gate.promise,
      readDocument,
    });
    const controller = new AbortController();
    const running = host.dispatch.callPi('read', { path: 'file' }, cwd, controller.signal);
    controller.abort();
    gate.resolve(new Map([['read', textTool(execute)]]));
    await expect(running).rejects.toThrow();
    expect(readDocument).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks real containment before document or tool effects, and refuses another cwd', async () => {
    const execute = vi.fn<CodingTool['execute']>();
    const readDocument = vi.fn(noDocument);
    const { host, cwd } = await make('bounded', {
      load: async () => new Map([['read', textTool(execute)]]),
      readDocument,
    });
    await expect(host.dispatch.callPi('read', { path: '../outside.pdf' }, cwd)).rejects.toThrow(
      'Path containment'
    );
    await expect(host.dispatch.callPi('read', {}, root)).rejects.toThrow(
      'cannot change working directory'
    );
    expect(readDocument).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses the host document reader without passing a PDF to the text tool', async () => {
    const execute = vi.fn<CodingTool['execute']>();
    const readDocument = vi.fn(async () => ({ success: true, text: 'document text' }));
    const { host, cwd } = await make('document', {
      load: async () => new Map([['read', textTool(execute)]]),
      readDocument,
    });
    const controller = new AbortController();
    expect(
      await host.dispatch.callPi('read', { path: 'page.pdf' }, cwd, controller.signal)
    ).toEqual({ success: true, text: 'document text' });
    expect(readDocument).toHaveBeenCalledExactlyOnceWith('page.pdf', cwd, controller.signal);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps image descriptors and cache teardown private, including close during creation', async () => {
    const coding = { load: async () => new Map<string, CodingTool>(), readDocument: noDocument };
    const first = await make('image-a', coding);
    const second = await make('image-b', coding);
    // Header fixture only: capture measures bytes, it does not decode them.
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).copy(bytes);
    bytes.write('IHDR', 12);
    bytes.writeUInt32BE(16, 16);
    bytes.writeUInt32BE(12, 20);
    const result = await first.host.images.captureToolImages(
      { content: [{ type: 'image', data: bytes.toString('base64') }] },
      { cacheDir: first.host.cacheDir, delivery: () => ({ deliverable: true }) }
    );
    const [image] = first.host.images.takeCapturedImages(result);
    expect(image).toBeDefined();
    expect(await readFile(image!.path)).toEqual(bytes);
    expect(second.host.images.takeCapturedImages(result)).toEqual([]);
    const otherCache = second.host.cacheDir();
    await first.host.close();
    await expect(readFile(image!.path)).rejects.toThrow();
    await expect(second.host.cacheDir()).resolves.toBe(await otherCache);
    await second.host.close();
    await expect(readFile(await otherCache)).rejects.toThrow();
    expect(() => first.host.dispatch.resolveCredentials({ key: '$EXAMPLE_KEY' })).toThrow('closed');
    expect(() => first.host.cacheDir()).toThrow('closed');
  });

  it('uses only the supplied image roots and home, not another host home', async () => {
    const execute = vi.fn<CodingTool['execute']>();
    const { host, cwd } = await make('images', {
      load: async () => new Map([['read', textTool(execute)]]),
      readDocument: noDocument,
    });
    const result = await host.dispatch.viewImage({ path: '~/.ink/files/foreign.png' }, cwd);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('outside the directories');
    expect(execute).not.toHaveBeenCalled();
  });

  it('real Pi read runs through the shared dispatcher in the named directory', async () => {
    // Real harmless fixture I/O, not a provider or a shell command.
    const pi = await import('@mariozechner/pi-coding-agent');
    const { host, cwd } = await make('real-read', {
      load: async (directory) =>
        new Map([['read', pi.createReadTool(directory) as unknown as CodingTool]]),
      readDocument: noDocument,
    });
    await writeFile(join(cwd, 'fixture.txt'), 'session-local read fixture\n');
    const ink = vi.fn();
    const dispatch = createLocalToolDispatcher({ cwd, ...host.dispatch, callInk: ink });
    const result = await dispatch('read', { path: 'fixture.txt' }, {});
    expect(result.text).toContain('session-local read fixture');
    expect(ink).not.toHaveBeenCalled();
  });
});

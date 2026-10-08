import { describe, expect, it, vi } from 'vitest';
import { createLocalToolDispatcher, type LocalToolDispatchDeps } from './tool-dispatch.js';
import { createToolParametersLookup } from './tool-parameter-help.js';

function fixture(cwd: string) {
  const callPi = vi.fn<LocalToolDispatchDeps['callPi']>(async () => ({ success: true }));
  const callInk = vi.fn<LocalToolDispatchDeps['callInk']>(async () => ({ success: true }));
  const image = vi.fn<LocalToolDispatchDeps['viewImage']>(async () => ({ content: [] }));
  const load = vi.fn<LocalToolDispatchDeps['loadCodingTools']>(
    async (directory) =>
      new Map([
        [
          'read',
          {
            description: `read for ${directory}`,
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      ])
  );
  const deps: LocalToolDispatchDeps = {
    cwd,
    callPi,
    callInk,
    viewImage: image,
    loadCodingTools: load,
    resolveCredentials: (args) => ({ ...args, credential: `fixture:${cwd}` }),
  };
  return { deps, callPi, callInk, image, load, dispatch: createLocalToolDispatcher(deps) };
}

describe('host-independent tool dispatch', () => {
  it('keeps concurrent coding schemas, working directories, images and credentials in their hosts', async () => {
    const a = fixture('/synthetic/a');
    const b = fixture('/synthetic/b');
    const [ad, bd] = await Promise.all([
      a.dispatch('describe_tool', { name: 'read' }, {}),
      b.dispatch('describe_tool', { name: 'read' }, {}),
    ]);
    expect(ad.tool).toMatchObject({
      description: 'read for /synthetic/a',
      parameters: { properties: { path: { type: 'string' } } },
    });
    expect(bd.tool).toMatchObject({ description: 'read for /synthetic/b' });
    const ca = new AbortController();
    const cb = new AbortController();
    await Promise.all([
      a.dispatch('mcp__inkwell__read', { path: 'a.txt' }, { signal: ca.signal }),
      b.dispatch('read', { path: 'b.txt' }, { signal: cb.signal }),
    ]);
    expect(a.callPi).toHaveBeenCalledWith('read', { path: 'a.txt' }, '/synthetic/a', ca.signal);
    expect(b.callPi).toHaveBeenCalledWith('read', { path: 'b.txt' }, '/synthetic/b', cb.signal);
    await Promise.all([
      a.dispatch('view_image', { path: 'a.png' }, { signal: ca.signal }),
      b.dispatch('view_image', { path: 'b.png' }, { signal: cb.signal }),
    ]);
    expect(a.image).toHaveBeenCalledWith({ path: 'a.png' }, '/synthetic/a', ca.signal);
    expect(b.image).toHaveBeenCalledWith({ path: 'b.png' }, '/synthetic/b', cb.signal);
    await Promise.all([
      a.dispatch('recall', { query: 'test' }, {}),
      b.dispatch('recall', { query: 'test' }, {}),
    ]);
    expect(a.callInk).toHaveBeenCalledWith('recall', {
      query: 'test',
      credential: 'fixture:/synthetic/a',
    });
    expect(b.callInk).toHaveBeenCalledWith('recall', {
      query: 'test',
      credential: 'fixture:/synthetic/b',
    });
  });
  it('uses the narrowed host discovery policy without calling or loading a denied tool', async () => {
    const f = fixture('/synthetic/a');
    f.deps.isHardDenied = (name) => name === 'read';
    expect(await f.dispatch('describe_tool', { name: 'read' }, {})).toMatchObject({
      success: false,
      error: expect.stringContaining('policy denies'),
    });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.callInk).not.toHaveBeenCalled();
    const context = await f.dispatch('describe_tool', { name: 'list_context' }, {});
    expect(context).toMatchObject({ success: true, tool: { name: 'list_context' } });
  });
  it('normalizes the name before the session-local context/clone head sees it', async () => {
    const f = fixture('/synthetic/a');
    const head = vi.fn(async () => ({ success: true, handled: true }));
    f.deps.head = head;
    const controller = new AbortController();
    expect(
      await f.dispatch(
        'mcp__inkwell__compact_context',
        { summary: 'brief' },
        { signal: controller.signal }
      )
    ).toMatchObject({ handled: true });
    expect(head).toHaveBeenCalledWith(
      'compact_context',
      { summary: 'brief' },
      { signal: controller.signal }
    );
    expect(f.callInk).not.toHaveBeenCalled();
    expect(f.callPi).not.toHaveBeenCalled();
  });
  it('keeps parameter caches scoped to the host and does not consult one when policy refuses help', async () => {
    const a = fixture('/synthetic/a');
    const b = fixture('/synthetic/b');
    const schema = (key: string) => ({
      tool: { parameters: { properties: { [key]: { type: 'string' } } } },
    });
    const la = vi.fn(async () => schema('a'));
    const lb = vi.fn(async () => schema('b'));
    a.deps.toolParameters = createToolParametersLookup(la);
    b.deps.toolParameters = createToolParametersLookup(lb);
    a.deps.mayLookUpParameters = () => true;
    b.deps.mayLookUpParameters = () => true;
    const [ar, br] = await Promise.all([
      a.dispatch('custom', { a: 'value' }, {}),
      b.dispatch('custom', { a: 'value' }, {}),
    ]);
    expect(ar).not.toHaveProperty('ignoredParameters');
    expect(br).toMatchObject({ ignoredParameters: { names: ['a'] } });
    expect(la).toHaveBeenCalledTimes(1);
    expect(lb).toHaveBeenCalledTimes(1);
    a.deps.mayLookUpParameters = () => false;
    expect(await a.dispatch('custom', { b: 'value' }, {})).not.toHaveProperty('ignoredParameters');
    expect(la).toHaveBeenCalledTimes(1);
  });
  it('answers impossible namespaces and miscasing locally rather than inventing a server capability', async () => {
    const f = fixture('/synthetic/a');
    expect(await f.dispatch('mcp__foreign__read', {}, {})).toMatchObject({ isError: true });
    expect(await f.dispatch('Read', {}, {})).toMatchObject({ isError: true });
    expect(f.callInk).not.toHaveBeenCalled();
    expect(f.callPi).not.toHaveBeenCalled();
  });
});

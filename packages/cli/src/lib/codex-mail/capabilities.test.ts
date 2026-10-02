import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertCodexMailCapabilities, probeCodexMailCapabilities } from './capabilities.js';

// No native process can execute. The mock writes only the probe's private
// temporary export directory; pure mutation tests need no filesystem at all.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const string = () => ({ type: 'string' });
const object = (properties: Record<string, any>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});
function fixture() {
  const text = object({ type: { enum: ['text'], type: 'string' }, text: string() });
  const content = { type: 'array', items: { oneOf: [text] } };
  const item = {
    oneOf: [object({ type: { enum: ['userMessage'] }, clientId: string(), content })],
  };
  const method = (name: string, params: Record<string, any>) =>
    object({ method: { enum: [name] }, params });
  const list = object(
    {
      threadId: string(),
      cursor: string(),
      limit: { type: 'integer' },
      sortDirection: { enum: ['asc', 'desc'] },
    },
    ['threadId']
  );
  return {
    requests: {
      oneOf: [
        ...['initialize', 'thread/start', 'thread/resume', 'config/read', 'hooks/list'].map(
          (name) => method(name, object({}))
        ),
        method(
          'thread/queue/add',
          object({ threadId: string(), clientUserMessageId: string(), input: content })
        ),
        method('thread/queue/list', list),
        method('thread/items/list', structuredClone(list)),
      ],
    },
    queue: object({
      data: { type: 'array', items: object({ clientUserMessageId: string() }) },
      nextCursor: string(),
    }),
    items: object({
      data: {
        type: 'array',
        items: object({ item, completedAtMs: { type: ['integer', 'null'] } }),
      },
      nextCursor: string(),
    }),
    notifications: {
      oneOf: [
        method('item/completed', object({ threadId: string(), item })),
        method('warning', object({ message: string() })),
      ],
    },
  };
}
const help = 'Usage: codex\n  --remote <ADDR>\n';
describe('Codex live-mail capabilities rather than release allowlists', () => {
  it('accepts compatible interfaces with additive optional fields and methods', () => {
    const schemas = fixture();
    schemas.requests.oneOf.push(object({ method: { enum: ['future/read'] }, params: object({}) }));
    expect(() => assertCodexMailCapabilities(schemas, help)).not.toThrow();
  });
  it.each([
    'queue method',
    'queue identity',
    'receipt time',
    'receipt identity',
    'new required input',
    'remote terminal',
  ])('refuses a concrete missing/changed capability: %s', (kind) => {
    const schemas = fixture();
    const add = schemas.requests.oneOf.find(
      (v) => v.properties.method.enum[0] === 'thread/queue/add'
    )!;
    if (kind === 'queue method')
      schemas.requests.oneOf = schemas.requests.oneOf.filter((v) => v !== add);
    if (kind === 'queue identity')
      add.properties.params.properties.clientUserMessageId = { type: 'integer' };
    if (kind === 'receipt time')
      delete schemas.items.properties.data.items.properties.completedAtMs;
    if (kind === 'receipt identity')
      delete schemas.items.properties.data.items.properties.item.oneOf[0].properties.clientId;
    if (kind === 'new required input') add.properties.params.required.push('newMandatoryField');
    expect(() =>
      assertCodexMailCapabilities(schemas, kind === 'remote terminal' ? 'Usage: codex' : help)
    ).toThrow('capability unavailable');
  });
  it('uses native schema/help probes, never --version, and does not start or resume a thread', () => {
    const schemas = fixture();
    vi.mocked(spawnSync).mockImplementation((_binary, args) => {
      if (args![0] === '--help') return { status: 0, stdout: help } as ReturnType<typeof spawnSync>;
      expect(args!.slice(0, 4)).toEqual([
        'app-server',
        'generate-json-schema',
        '--experimental',
        '--out',
      ]);
      const directory = args![4];
      mkdirSync(join(directory, 'v2'));
      for (const [file, schema] of [
        ['ClientRequest.json', schemas.requests],
        ['v2/ThreadQueueListResponse.json', schemas.queue],
        ['v2/ThreadItemsListResponse.json', schemas.items],
        ['ServerNotification.json', schemas.notifications],
      ] as const)
        writeFileSync(join(directory, file), JSON.stringify(schema));
      return { status: 0, stdout: '' } as ReturnType<typeof spawnSync>;
    });
    probeCodexMailCapabilities({
      binary: 'fixture-codex-future-version',
      cwd: '/fixture',
      env: {},
    });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnSync).mock.calls.flatMap(([, args]) => args ?? [])).not.toContain(
      '--version'
    );
  });
  it('does not echo native diagnostics when export fails', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stderr: 'SYNTHETIC_PRIVATE_VALUE',
    } as ReturnType<typeof spawnSync>);
    expect(() =>
      probeCodexMailCapabilities({ binary: 'fixture-only', cwd: '/fixture', env: {} })
    ).toThrow('capability unavailable');
    try {
      probeCodexMailCapabilities({ binary: 'fixture-only', cwd: '/fixture', env: {} });
    } catch (error) {
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
    }
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  definitions?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
};

function need(condition: unknown, capability: string): asserts condition {
  if (!condition) throw new Error(`Codex Inkmail capability unavailable: ${capability}`);
}
function resolve(root: Schema, node: Schema | undefined): Schema {
  for (let n = 0; n < 12; n++) {
    need(node && typeof node === 'object', 'protocol schema');
    if (!node.$ref) return node;
    need(node.$ref.startsWith('#/definitions/'), 'local protocol definitions');
    node = root.definitions?.[node.$ref.slice('#/definitions/'.length)];
  }
  throw new Error('Codex Inkmail capability unavailable: recursive protocol definition');
}
function hasType(root: Schema, node: Schema | undefined, type: string): boolean {
  const value = resolve(root, node);
  if ((Array.isArray(value.type) ? value.type : [value.type]).includes(type)) return true;
  return [...(value.anyOf ?? []), ...(value.oneOf ?? [])].some((v) => hasType(root, v, type));
}
function field(root: Schema, node: Schema, key: string, type?: string): Schema {
  const value = resolve(root, node).properties?.[key];
  need(value && (!type || hasType(root, value, type)), `${key}${type ? ` (${type})` : ''}`);
  return resolve(root, value);
}
function variant(root: Schema, node: Schema, key: string, value: string): Schema {
  const schema = resolve(root, node);
  const match = (schema.oneOf ?? schema.anyOf ?? []).find((entry) =>
    resolve(root, entry).properties?.[key]?.enum?.includes(value)
  );
  need(match, value);
  return resolve(root, match);
}

/** Inspect only the interfaces this adapter uses, not a release number or an
 * entire schema snapshot. Additive fields/methods do not disable live mail.
 * This is structural compatibility evidence; runtime replies still require
 * exact receipts and can pause delivery if their behavior changes. */
export function assertCodexMailCapabilities(
  schemas: {
    requests: Schema;
    queue: Schema;
    items: Schema;
    notifications: Schema;
  },
  help: string
): void {
  need(/--remote\s+<[^>]+>/.test(help), 'native --remote terminal');
  const { requests, queue, items, notifications } = schemas;
  const params = (method: string) =>
    field(requests, variant(requests, requests, 'method', method), 'params');
  for (const method of ['initialize', 'thread/start', 'thread/resume', 'config/read', 'hooks/list'])
    params(method);
  const add = params('thread/queue/add');
  need(
    (add.required ?? []).every((key) => ['threadId', 'clientUserMessageId', 'input'].includes(key)),
    'queue/add required inputs'
  );
  field(requests, add, 'threadId', 'string');
  field(requests, add, 'clientUserMessageId', 'string');
  const input = field(requests, add, 'input', 'array');
  const text = variant(requests, resolve(requests, input.items), 'type', 'text');
  field(requests, text, 'text', 'string');
  need(
    (text.required ?? []).every((key) => ['type', 'text'].includes(key)),
    'text input required fields'
  );
  for (const method of ['thread/queue/list', 'thread/items/list']) {
    const list = params(method);
    field(requests, list, 'threadId', 'string');
    field(requests, list, 'cursor');
    field(requests, list, 'limit');
    need(
      (list.required ?? []).every((key) => ['threadId'].includes(key)),
      `${method} required inputs`
    );
  }
  field(requests, params('thread/items/list'), 'sortDirection');
  const submission = resolve(queue, field(queue, queue, 'data', 'array').items);
  field(queue, submission, 'clientUserMessageId', 'string');
  field(queue, queue, 'nextCursor', 'string');
  const entry = resolve(items, field(items, items, 'data', 'array').items);
  const completed = field(items, entry, 'completedAtMs');
  need(
    hasType(items, completed, 'integer') || hasType(items, completed, 'number'),
    'completed receipt timestamp'
  );
  const userMessage = variant(items, field(items, entry, 'item'), 'type', 'userMessage');
  field(items, userMessage, 'clientId', 'string');
  const content = field(items, userMessage, 'content', 'array');
  field(items, variant(items, resolve(items, content.items), 'type', 'text'), 'text', 'string');
  field(items, items, 'nextCursor', 'string');
  const completedEvent = field(
    notifications,
    variant(notifications, notifications, 'method', 'item/completed'),
    'params'
  );
  field(notifications, completedEvent, 'threadId', 'string');
  field(notifications, completedEvent, 'item');
  const warning = field(
    notifications,
    variant(notifications, notifications, 'method', 'warning'),
    'params'
  );
  field(notifications, warning, 'message', 'string');
}

/** Static native schema export and help only: no thread, hook, MCP server or
 * model execution. Effective hook configuration is checked separately using
 * the exact launch arguments. Never infer support from a version allowlist. */
export function probeCodexMailCapabilities(options: {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): void {
  const directory = mkdtempSync(join(tmpdir(), 'ink-mail-capabilities-'));
  try {
    const invoke = (args: string[]) =>
      spawnSync(options.binary, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    const help = invoke(['--help']);
    need(help.status === 0, 'native CLI help');
    const exported = invoke([
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      directory,
    ]);
    need(exported.status === 0, 'native protocol schema export');
    const read = (path: string) =>
      JSON.parse(readFileSync(join(directory, path), 'utf8')) as Schema;
    assertCodexMailCapabilities(
      {
        requests: read('ClientRequest.json'),
        queue: read('v2/ThreadQueueListResponse.json'),
        items: read('v2/ThreadItemsListResponse.json'),
        notifications: read('ServerNotification.json'),
      },
      help.stdout
    );
  } catch (error) {
    // Do not leak native stderr or config values through fallback diagnostics.
    if (error instanceof Error && error.message.startsWith('Codex Inkmail capability unavailable:'))
      throw error;
    throw new Error('Codex Inkmail capability check could not read the required native protocol');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

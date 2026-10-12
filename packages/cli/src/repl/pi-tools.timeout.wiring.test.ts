import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The production wiring: `initPiTools` must hand out a bash tool whose every
 * call carries a bounded timeout. Pi is replaced here so the test reads the
 * exact arguments the real tool would have received, without waiting out a
 * ten-minute default. The real-process behaviour of a bounded call is in
 * pi-tools.timeout.test.ts.
 */
const received = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@mariozechner/pi-coding-agent', () => {
  const stub = (name: string) => () => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  });
  return {
    createReadTool: stub('read'),
    createEditTool: stub('edit'),
    createWriteTool: stub('write'),
    createGrepTool: stub('grep'),
    createFindTool: stub('find'),
    createLsTool: stub('ls'),
    createBashTool: () => ({
      name: 'bash',
      description: 'bash',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command to execute' },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (optional, no default timeout)',
          },
        },
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        received.push(params);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    }),
  };
});

const { callPiTool, initPiTools } = await import('./pi-tools.js');

describe('pi-tools: every bash call from initPiTools carries a bounded timeout', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'pi-bash-wiring-'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  beforeEach(() => {
    received.length = 0;
  });

  it.each([
    ['omitted', undefined, 600],
    ['zero, which pi reads as no timeout', 0, 600],
    ['negative', -5, 600],
    ['not a number', 'soon', 600],
    ['non-finite', Number.POSITIVE_INFINITY, 600],
    ['within the ceiling', 30, 30],
    ['a numeric string', '45', 45],
    ['above the ceiling', 5000, 1800],
  ])('timeout %s runs with %#', async (_label, timeout, expected) => {
    const args: Record<string, unknown> = { command: 'true' };
    if (timeout !== undefined) args.timeout = timeout;
    const before = { ...args };

    await callPiTool('bash', args, cwd);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ command: 'true', timeout: expected });
    // The caller's arguments are left as they were.
    expect(args).toEqual(before);
  });

  it('tells the model the real limits, not pi’s “no default timeout”', async () => {
    const bash = (await initPiTools(cwd)).get('bash');
    const schema = bash?.parameters as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(schema.properties.timeout.type).toBe('number');
    expect(schema.properties.timeout.description).toContain('default 600, max 1800');
    expect(schema.properties.timeout.description).not.toContain('no default');
    expect(schema.properties.command.description).toBe('Bash command to execute');
  });
});

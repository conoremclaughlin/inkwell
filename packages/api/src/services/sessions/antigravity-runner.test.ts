/**
 * AntigravityRunner unit tests.
 *
 * The flag-mapping tests look trivial but are the point: this runner was
 * written next to GeminiRunner, and every one of these flags is renamed
 * between the two CLIs. A copy-paste that leaves `--yolo` or `-o` in place
 * produces a runner that spawns, fails, and reports nothing useful — which is
 * exactly how the Gemini outage stayed invisible for two months.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const hoisted = vi.hoisted(() => ({ home: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => hoisted.home };
});

import {
  buildAgyArgs,
  extractTextDelta,
  extractToolData,
  normalizeInput,
  AntigravityRunner,
} from './antigravity-runner.js';
import type { ClaudeRunnerConfig } from './types.js';

const baseConfig = (overrides: Partial<ClaudeRunnerConfig> = {}): ClaudeRunnerConfig => ({
  workingDirectory: '/tmp/work',
  mcpConfigPath: '/tmp/.mcp.json',
  ...overrides,
});

describe('buildAgyArgs', () => {
  it('uses agy flag names, not the Gemini CLI ones', () => {
    const args = buildAgyArgs('hello', baseConfig());

    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--dangerously-skip-permissions');

    // The Gemini spellings must not survive a copy-paste.
    expect(args).not.toContain('-o');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--policy');
    expect(args).not.toContain('-r');
  });

  it('passes the message via -p', () => {
    const args = buildAgyArgs('hello world', baseConfig());
    expect(args[args.indexOf('-p') + 1]).toBe('hello world');
  });

  it('resumes with --conversation, not -r', () => {
    const args = buildAgyArgs('hi', baseConfig(), 'conv-abc-123');
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-abc-123');
    expect(args).not.toContain('-r');
  });

  it('omits --conversation entirely on a fresh run', () => {
    expect(buildAgyArgs('hi', baseConfig())).not.toContain('--conversation');
  });

  it('passes the model via --model, not -m', () => {
    const args = buildAgyArgs('hi', baseConfig({ model: 'gemini-3-pro' }));
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3-pro');
    expect(args).not.toContain('-m');
  });

  it('raises --print-timeout above the agy default of 5m', () => {
    const args = buildAgyArgs('hi', baseConfig());
    const raw = args[args.indexOf('--print-timeout') + 1];
    expect(raw).toMatch(/^\d+s$/);
    // Anything at or under agy's own 300s default would cap agent work.
    expect(Number(raw.replace('s', ''))).toBeGreaterThan(300);
  });
});

describe('extractTextDelta', () => {
  it('reads text_delta off a step_update', () => {
    expect(extractTextDelta({ event: 'step_update', text_delta: 'partial' })).toBe('partial');
  });

  it('reads text_delta from a nested step_update payload', () => {
    expect(extractTextDelta({ event: 'step_update', step_update: { text_delta: 'inner' } })).toBe(
      'inner'
    );
  });

  it('ignores the result event so the final response is not doubled', () => {
    // The result event repeats the whole response. If it were treated as a
    // delta it would be appended to the accumulated deltas that already spell
    // out the same text.
    expect(extractTextDelta({ event: 'result', result: { response: 'the whole answer' } })).toBe(
      undefined
    );
  });

  it('ignores init', () => {
    expect(extractTextDelta({ event: 'init', cwd: '/tmp' })).toBe(undefined);
  });
});

describe('extractToolData', () => {
  it('pulls a tool call out of step_update.tool_info', () => {
    const { toolCalls } = extractToolData({
      event: 'step_update',
      step_update: {
        tool_info: { name: 'read_file', parameters: { path: '/tmp/x' } },
      },
    });

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolName).toBe('read_file');
    expect(toolCalls[0].input).toEqual({ path: '/tmp/x' });
  });

  it('captures send_response as a channel response', () => {
    const { responses } = extractToolData({
      event: 'step_update',
      step_update: {
        tool_info: {
          name: 'mcp__inkwell__send_response',
          parameters: { channel: 'telegram', conversationId: '42', content: 'hi there' },
        },
      },
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      channel: 'telegram',
      conversationId: '42',
      content: 'hi there',
    });
  });

  it('drops a send_response that is missing content rather than emitting an empty message', () => {
    const { responses } = extractToolData({
      event: 'step_update',
      step_update: {
        tool_info: { name: 'mcp__inkwell__send_response', parameters: { channel: 'telegram' } },
      },
    });
    expect(responses).toEqual([]);
  });

  it('terminates on a self-referencing event instead of hanging the parser', () => {
    // agy is closed-source and its envelope has already changed shape once, so
    // the walk is breadth-first over the whole object. A cycle in that input
    // would otherwise spin forever inside the stdout handler.
    const cyclic: Record<string, unknown> = { event: 'step_update' };
    cyclic.self = cyclic;
    expect(() => extractToolData(cyclic)).not.toThrow();
  });

  it('finds tool calls regardless of where the envelope nests them', () => {
    const { toolCalls } = extractToolData({
      event: 'step_update',
      some: { future: { shape: { name: 'grep', parameters: { pattern: 'x' } } } },
    });
    expect(toolCalls.map((t) => t.toolName)).toEqual(['grep']);
  });
});

describe('normalizeInput', () => {
  it('parses a JSON string payload', () => {
    expect(normalizeInput('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns an object payload untouched', () => {
    expect(normalizeInput({ a: 1 })).toEqual({ a: 1 });
  });

  it('returns undefined when there is no payload at all', () => {
    // Distinct from {}: a bare `name` with no args is not a tool call, and
    // treating it as one invents calls out of ordinary prose fields.
    expect(normalizeInput(undefined)).toBe(undefined);
    expect(normalizeInput(null)).toBe(undefined);
  });

  it('degrades an unparseable string to an empty object', () => {
    expect(normalizeInput('not json')).toEqual({});
  });
});

describe('ensureGlobalMcpConfig', () => {
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agy-home-'));
    hoisted.home = home;
    configPath = join(home, '.gemini', 'config', 'mcp_config.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // The method is private because nothing outside the runner should call it;
  // reaching in is deliberate, and cheaper than spawning agy to observe a file.
  const ensure = (runner: AntigravityRunner) =>
    (runner as unknown as { ensureGlobalMcpConfig: () => Promise<void> }).ensureGlobalMcpConfig();

  it('writes an inkwell stdio entry when no config exists', async () => {
    await ensure(new AntigravityRunner());

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.inkwell.command).toBe(process.execPath);
    expect(written.mcpServers.inkwell.args[0]).toMatch(/antigravity-mcp-bridge\.mjs$/);
  });

  it('writes no token or session id into the file', async () => {
    // The whole reason for the bridge: this file is host-global and shared by
    // every concurrent SB, so anything session-specific in it is both a leak
    // and a race.
    await ensure(new AntigravityRunner());

    const raw = readFileSync(configPath, 'utf-8');
    expect(raw).not.toMatch(/Bearer/);
    expect(raw).not.toMatch(/INK_ACCESS_TOKEN/);
    expect(raw).not.toMatch(/x-ink-context/);
    expect(JSON.parse(raw).mcpServers.inkwell).not.toHaveProperty('headers');
    expect(JSON.parse(raw).mcpServers.inkwell).not.toHaveProperty('env');
  });

  it('preserves MCP servers the user configured themselves', async () => {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { sqlite: { command: 'sqlite-mcp-server' } } })
    );

    await ensure(new AntigravityRunner());

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.sqlite).toEqual({ command: 'sqlite-mcp-server' });
    expect(written.mcpServers.inkwell).toBeDefined();
  });

  it('is a no-op on the second call, so concurrent spawns cannot race', async () => {
    const runner = new AntigravityRunner();
    await ensure(runner);
    const first = readFileSync(configPath, 'utf-8');

    await ensure(runner);
    expect(readFileSync(configPath, 'utf-8')).toBe(first);
  });

  it('recovers from an unparseable config rather than refusing to run', async () => {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(configPath, '{ not json');

    await ensure(new AntigravityRunner());

    expect(JSON.parse(readFileSync(configPath, 'utf-8')).mcpServers.inkwell).toBeDefined();
  });
});

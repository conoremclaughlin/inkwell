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
  unwrapMcpCall,
  resolveInkMcpUrl,
  applyAgyEvent,
  newAgyStreamState,
  stagedBridgePath,
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
    expect(written.mcpServers.inkwell.command).toMatch(/antigravity-mcp-bridge\.mjs$/);
    expect(written.mcpServers.inkwell.args).toEqual([]);
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

  it('is a no-op on the second call', async () => {
    const runner = new AntigravityRunner();
    await ensure(runner);
    const first = readFileSync(configPath, 'utf-8');

    await ensure(runner);
    expect(readFileSync(configPath, 'utf-8')).toBe(first);
  });

  it('publishes a bridge path that does not name the spawning checkout', async () => {
    // The config is host-global, so whatever path lands in it is executed by
    // every server on the machine — main, dist, and each isolated worktree.
    // A __dirname-relative path means one process runs another's bridge, or a
    // path whose worktree has since been deleted.
    await ensure(new AntigravityRunner());

    const entry = JSON.parse(readFileSync(configPath, 'utf-8')).mcpServers.inkwell;
    expect(entry.command).toBe(stagedBridgePath());
    expect(entry.args).toEqual([]);
    expect(entry.command).not.toContain('packages/api');
    expect(entry.command).not.toContain(process.execPath);
  });

  it('survives genuinely parallel writers without losing another server', async () => {
    // The real contention is between separate Node servers, so this drives
    // ensureGlobalMcpConfig concurrently rather than twice in sequence.
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { sqlite: { command: 'sqlite-mcp-server' } } })
    );

    await Promise.all(Array.from({ length: 8 }, () => ensure(new AntigravityRunner())));

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.sqlite).toEqual({ command: 'sqlite-mcp-server' });
    expect(written.mcpServers.inkwell.command).toBe(stagedBridgePath());
  });

  it('leaves an unparseable config alone instead of erasing servers it cannot see', async () => {
    // Reversed from the original behaviour on purpose. Treating a parse failure
    // as {} and writing over it destroys every other MCP server the user has.
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(configPath, '{ not json');

    await ensure(new AntigravityRunner());

    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });

  it('creates the config when the file does not exist yet', async () => {
    await ensure(new AntigravityRunner());
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).mcpServers.inkwell).toBeDefined();
  });
});

describe('unwrapMcpCall', () => {
  it("turns agy's call_mcp_tool wrapper into a namespaced Ink tool name", () => {
    // agy never emits mcp__inkwell__*. Every MCP call arrives as this wrapper,
    // so without unwrapping the activity stream sees only `call_mcp_tool`.
    const { toolName, input } = unwrapMcpCall('call_mcp_tool', {
      ServerName: 'inkwell',
      ToolName: 'get_timezone',
      Arguments: { userId: 'u1' },
    });

    expect(toolName).toBe('mcp__inkwell__get_timezone');
    expect(input).toEqual({ userId: 'u1' });
  });

  it('recognises send_response through the wrapper', () => {
    // This is the one that matters most: unrecognised means a reply the agent
    // genuinely sent never reaches its channel.
    const { responses } = extractToolData({
      event: 'step_update',
      step_update: {
        state: 'DONE',
        tool_info: {
          name: 'call_mcp_tool',
          parameters: {
            ServerName: 'inkwell',
            ToolName: 'send_response',
            Arguments: { channel: 'telegram', conversationId: '7', content: 'done' },
          },
        },
      },
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ channel: 'telegram', content: 'done' });
  });

  it('leaves a native tool name untouched', () => {
    expect(unwrapMcpCall('read_file', { path: '/x' })).toEqual({
      toolName: 'read_file',
      input: { path: '/x' },
    });
  });

  it('leaves the wrapper alone when the shape is not what we expect', () => {
    const { toolName } = unwrapMcpCall('call_mcp_tool', { unexpected: true });
    expect(toolName).toBe('call_mcp_tool');
  });
});

describe('tool lifecycle deduplication', () => {
  const toolEvent = (state: string) => ({
    event: 'step_update',
    step_update: {
      state,
      tool_info: {
        name: 'call_mcp_tool',
        parameters: { ServerName: 'inkwell', ToolName: 'recall', Arguments: {} },
      },
    },
  });

  it('records the DONE half only', () => {
    // agy reports each tool twice. Counting both doubles every activity entry
    // and would deliver a send_response twice.
    expect(extractToolData(toolEvent('ACTIVE')).toolCalls).toHaveLength(0);
    expect(extractToolData(toolEvent('DONE')).toolCalls).toHaveLength(1);
  });
});

describe('resolveInkMcpUrl', () => {
  const original = process.env.INK_SERVER_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.INK_SERVER_URL;
    else process.env.INK_SERVER_URL = original;
  });

  it('prefers INK_SERVER_URL, which is what the container orchestrator rewrites', async () => {
    process.env.INK_SERVER_URL = 'http://host.docker.internal:3001';
    await expect(resolveInkMcpUrl(baseConfig())).resolves.toBe(
      'http://host.docker.internal:3001/mcp'
    );
  });

  it('falls back to the workspace .mcp.json so an isolated server is not sent to :3001', async () => {
    // The failure this prevents: a server on PCP_PORT_BASE=4001 handing its
    // bearer token and context to the MAIN server on 3001.
    delete process.env.INK_SERVER_URL;
    const dir = mkdtempSync(join(tmpdir(), 'agy-ws-'));
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { inkwell: { url: 'http://localhost:4001/mcp' } } })
    );

    await expect(resolveInkMcpUrl(baseConfig({ workingDirectory: dir }))).resolves.toBe(
      'http://localhost:4001/mcp'
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to :3001 only when nothing else says otherwise', async () => {
    delete process.env.INK_SERVER_URL;
    await expect(resolveInkMcpUrl(baseConfig({ workingDirectory: '/nonexistent' }))).resolves.toBe(
      'http://localhost:3001/mcp'
    );
  });
});

describe('applyAgyEvent', () => {
  it('records conversation_id from the init event, before any tool work', () => {
    // agy 1.1.13 emits it here. If we waited for the result event, a crash or
    // kill after the agent had already caused side effects would discard the
    // conversation, and the next message would start fresh and repeat them.
    const acc = newAgyStreamState();
    applyAgyEvent(acc, { event: 'init', conversation_id: 'conv-early', cwd: '/tmp' });

    expect(acc.conversationId).toBe('conv-early');
  });

  it('lets the result event override the init id', () => {
    const acc = newAgyStreamState();
    applyAgyEvent(acc, { event: 'init', conversation_id: 'conv-early' });
    applyAgyEvent(acc, {
      event: 'result',
      result: { conversation_id: 'conv-final', status: 'SUCCESS' },
    });

    expect(acc.conversationId).toBe('conv-final');
  });

  it('omits contextTokens rather than aliasing it to run billing', () => {
    // agy's total_tokens sums every step, counting earlier steps repeatedly.
    // contextTokens means "currently in the context window"; absent means
    // unknown, not zero.
    const acc = newAgyStreamState();
    applyAgyEvent(acc, {
      event: 'result',
      result: {
        status: 'SUCCESS',
        usage: { input_tokens: 5341, output_tokens: 210, total_tokens: 27641 },
      },
    });

    expect(acc.usage).toEqual({ inputTokens: 5341, outputTokens: 210 });
    expect(acc.usage).not.toHaveProperty('contextTokens');
  });

  it('carries the failure status and message off the result event', () => {
    const acc = newAgyStreamState();
    applyAgyEvent(acc, {
      event: 'result',
      result: { status: 'ERROR', error: 'authentication failed or timed out' },
    });

    expect(acc.status).toBe('ERROR');
    expect(acc.error).toBe('authentication failed or timed out');
  });

  it('accumulates text deltas and then lets the final response replace them', () => {
    const acc = newAgyStreamState();
    applyAgyEvent(acc, { event: 'step_update', step_update: { text_delta: 'par' } });
    applyAgyEvent(acc, { event: 'step_update', step_update: { text_delta: 'tial' } });
    expect(acc.finalTextResponse).toBe('partial');

    applyAgyEvent(acc, { event: 'result', result: { status: 'SUCCESS', response: 'partial' } });
    expect(acc.finalTextResponse).toBe('partial');
  });
});

describe('run() failure classification', () => {
  /** Drive run() with a canned spawn result, bypassing the real agy binary. */
  const withSpawnResult = (result: Record<string, unknown>) => {
    const runner = new AntigravityRunner();
    (runner as unknown as { spawnProcess: () => Promise<unknown> }).spawnProcess = () =>
      Promise.resolve(result);
    return runner;
  };

  it('reports a timed-out turn as a failure, not a success', async () => {
    // Both timeout branches used to resolve with no status. run() only fails
    // when status is present and non-SUCCESS, so a killed turn came back
    // success:true — the session went idle and the "[Process timed out]"
    // marker could be forwarded to a human as the agent's answer.
    const runner = withSpawnResult({
      responses: [],
      toolCalls: [],
      status: 'TIMEOUT',
      error: 'Antigravity produced no output for 300s and was killed',
      finalTextResponse: '[Process timed out after 300s idle]',
    });

    const result = await runner.run('hi', { config: baseConfig() });

    expect(result.success).toBe(false);
    expect(result.error).toContain('killed');
  });

  it('keeps the conversation id on a failed turn so it can be resumed', async () => {
    const runner = withSpawnResult({
      responses: [],
      toolCalls: [],
      conversationId: 'conv-from-init',
      status: 'TIMEOUT',
      error: 'killed',
    });

    const result = await runner.run('hi', { config: baseConfig() });

    expect(result.success).toBe(false);
    expect(result.backendSessionId).toBe('conv-from-init');
  });

  it('reports SUCCESS as success', async () => {
    const runner = withSpawnResult({
      responses: [],
      toolCalls: [],
      status: 'SUCCESS',
      conversationId: 'conv-ok',
      finalTextResponse: 'done',
    });

    const result = await runner.run('hi', { config: baseConfig() });

    expect(result.success).toBe(true);
    expect(result.backendSessionId).toBe('conv-ok');
  });
});

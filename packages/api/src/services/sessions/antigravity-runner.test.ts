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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
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
  isTurnSuccessful,
  resolveInkMcpUrl,
  launcherPath,
  bridgePathForContent,
  stageBridge,
  applyAgyEvent,
  newAgyStreamState,
  AntigravityRunner,
} from './antigravity-runner.js';
import type { ClaudeRunnerConfig } from './types.js';
import { classifyError } from '@inklabs/shared';

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

  // spec:studio-materialization v8 (PR #544 r3) — agy's workspace grant.
  // --dangerously-skip-permissions approves prompts but does NOT add a
  // workspace directory; without --add-dir an agy session can have the host
  // MCP mint a studio it cannot edit, build, or test.
  it('grants --add-dir for the ephemeral-studio root on fresh and resume shapes', () => {
    const prevRoot = process.env.INK_STUDIOS_ROOT;
    process.env.INK_STUDIOS_ROOT = '/tmp/ink-studios-agy-test';
    try {
      for (const conversationId of [undefined, 'conv-abc-123']) {
        const args = buildAgyArgs('hi', baseConfig(), conversationId);
        const granted = args
          .map((arg, i) => (arg === '--add-dir' ? args[i + 1] : null))
          .filter(Boolean);
        expect(granted).toContain('/tmp/ink-studios-agy-test');
      }
    } finally {
      if (prevRoot === undefined) delete process.env.INK_STUDIOS_ROOT;
      else process.env.INK_STUDIOS_ROOT = prevRoot;
    }
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

  it('never synthesises a ChannelResponse, because the MCP server already sent it', () => {
    // The bridge calls the LIVE Inkwell MCP server, so handleSendResponse has
    // already invoked the ChannelGateway by the time this event is parsed.
    // Returning a response here makes server.ts route the same message again
    // and the user receives it twice.
    const { responses, toolCalls } = extractToolData({
      event: 'step_update',
      step_update: {
        state: 'DONE',
        tool_info: {
          name: 'mcp__inkwell__send_response',
          parameters: { channel: 'telegram', conversationId: '42', content: 'hi there' },
        },
      },
    });

    expect(responses).toEqual([]);
    // Still recorded for the activity stream.
    expect(toolCalls[0].toolName).toBe('mcp__inkwell__send_response');
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
    (runner as unknown as { ensureGlobalMcpConfig: () => Promise<string> }).ensureGlobalMcpConfig();

  it('writes an inkwell stdio entry when no config exists', async () => {
    await ensure(new AntigravityRunner());

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.inkwell.command).toBe(launcherPath());
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
    expect(entry.command).toBe(launcherPath());
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
    expect(written.mcpServers.inkwell.command).toBe(launcherPath());
  });

  it('leaves an unparseable config alone AND fails closed', async () => {
    // Two separate obligations. Preserving the file is data safety — we cannot
    // see what else it holds. Throwing is the safety that matters more: a
    // successful return would start agy with no bootstrap, no memory and no
    // send_response, and it would still produce a fluent-looking answer.
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(configPath, '{ not json');

    await expect(ensure(new AntigravityRunner())).rejects.toThrow(/refusing to start agy/);
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

  it('recognises send_response through the wrapper without re-routing it', () => {
    const { responses, toolCalls } = extractToolData({
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

    // Named correctly for the activity stream, but NOT re-delivered: the live
    // MCP handler already sent it.
    expect(toolCalls[0].toolName).toBe('mcp__inkwell__send_response');
    expect(responses).toEqual([]);
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
  // Every port/URL variable has to be isolated, not just INK_SERVER_URL. This
  // studio runs with INK_PORT_BASE=3001 set, and leaving it visible made the
  // "falls back to the workspace file" case resolve from the port base instead
  // — the suite passed for me and failed for Lumen (round three).
  const PORT_ENV = ['INK_SERVER_URL', 'INK_PORT_BASE', 'PCP_PORT_BASE'] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PORT_ENV) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PORT_ENV) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('prefers INK_SERVER_URL, which is what the container orchestrator rewrites', async () => {
    process.env.INK_SERVER_URL = 'http://host.docker.internal:3001';
    await expect(resolveInkMcpUrl(baseConfig())).resolves.toBe(
      'http://host.docker.internal:3001/mcp'
    );
  });

  it('falls back to the workspace .mcp.json when nothing more authoritative exists', async () => {
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

describe('bridge publication (version crossover)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agy-home-'));
    hoisted.home = home;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('names the launcher, whose content does not vary with the bridge revision', async () => {
    // The launcher is what the shared config points at. If ITS bytes changed
    // per revision we would be back to last-writer-wins on a shared executable.
    const { launcher } = await stageBridge();
    expect(launcher).toBe(launcherPath());

    const first = readFileSync(launcher, 'utf-8');
    await stageBridge();
    expect(readFileSync(launcher, 'utf-8')).toBe(first);
    expect(first).toContain('INK_BRIDGE_PATH');
  });

  it('gives different bridge revisions different paths so they coexist', async () => {
    // The round-one fix stabilised the config path but left every server
    // overwriting one shared executable — a peer on another revision could
    // swap it out between our staging it and agy exec'ing it.
    const a = bridgePathForContent('bridge revision A');
    const b = bridgePathForContent('bridge revision B');

    expect(a).not.toBe(b);
    expect(bridgePathForContent('bridge revision A')).toBe(a);
  });

  it('stages an executable bridge and returns its content-addressed path', async () => {
    const { bridge } = await stageBridge();
    expect(bridge).toMatch(/antigravity-mcp-bridge-[0-9a-f]{16}\.mjs$/);
    expect(statSync(bridge).mode & 0o111).toBeGreaterThan(0);
  });
});

describe('resolveInkMcpUrl — isolated servers', () => {
  const saved = { url: process.env.INK_SERVER_URL, base: process.env.PCP_PORT_BASE };
  afterEach(() => {
    for (const [k, v] of [
      ['INK_SERVER_URL', saved.url],
      ['PCP_PORT_BASE', saved.base],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.INK_PORT_BASE;
  });

  it('uses the endpoint the server bound, over any config file', async () => {
    delete process.env.INK_SERVER_URL;
    delete process.env.PCP_PORT_BASE;
    await expect(
      resolveInkMcpUrl(baseConfig({ inkMcpUrl: 'http://localhost:4001/mcp' }))
    ).resolves.toBe('http://localhost:4001/mcp');
  });

  it('honours PCP_PORT_BASE even when the repo .mcp.json still says 3001', async () => {
    // This is the documented isolation recipe: `PCP_PORT_BASE=4001 yarn dev`
    // does NOT rewrite the committed .mcp.json. Trusting that file would send
    // an isolated server's bearer token to the MAIN server.
    delete process.env.INK_SERVER_URL;
    process.env.PCP_PORT_BASE = '4001';

    const dir = mkdtempSync(join(tmpdir(), 'agy-repo-'));
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { inkwell: { url: 'http://localhost:3001/mcp' } } })
    );

    await expect(resolveInkMcpUrl(baseConfig({ workingDirectory: dir }))).resolves.toBe(
      'http://localhost:4001/mcp'
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('non-zero exit handling', () => {
  const withSpawnResult = (result: Record<string, unknown>) => {
    const runner = new AntigravityRunner();
    (runner as unknown as { spawnProcess: () => Promise<unknown> }).spawnProcess = () =>
      Promise.resolve(result);
    return runner;
  };

  it('reports a crash as a failure and keeps the init conversation id', async () => {
    // Rejecting here used to discard the accumulator, so the id agy emitted on
    // `init` was lost and the next message started a fresh conversation —
    // able to repeat side effects the crashed turn already performed.
    const runner = withSpawnResult({
      responses: [],
      toolCalls: [],
      conversationId: 'conv-from-init',
      status: 'CRASH',
      error: 'agy exited with code 1: no error output captured',
    });

    const result = await runner.run('hi', { config: baseConfig() });

    expect(result.success).toBe(false);
    expect(result.backendSessionId).toBe('conv-from-init');
  });

  it('reports a crash as a failure even when partial text arrived first', async () => {
    // The old branch only rejected when there was no output at all, so a
    // non-zero exit after partial text resolved with no status — success:true.
    const runner = withSpawnResult({
      responses: [],
      toolCalls: [],
      status: 'CRASH',
      error: 'agy exited with code 1',
      finalTextResponse: 'I was partway through when',
    });

    const result = await runner.run('hi', { config: baseConfig() });
    expect(result.success).toBe(false);
  });

  it('classifies a timeout as a timeout, not a crash', async () => {
    // classifyError matches on the word "timeout". Without it the turn is a
    // non-retryable crash and queued messages get flushed.
    const runner = withSpawnResult({
      responses: [],
      toolCalls: [],
      status: 'TIMEOUT',
      error: 'Antigravity timeout: no output for 300s, process killed',
    });

    const result = await runner.run('hi', { config: baseConfig() });
    expect(result.success).toBe(false);
    const classified = classifyError({ errorText: result.error ?? '' });
    expect(classified.category).toBe('timeout');
    expect(classified.retryable).toBe(true);
  });
});

describe('isTurnSuccessful — a recovered tool error is not a failed turn', () => {
  // Measured against agy 1.1.13. These two envelopes both carry status:'ERROR'
  // and mean opposite things; the response body is what separates them.
  it('treats a recovered tool error as success', () => {
    // Real capture: the agent hit an MCP validation error, handled it, and
    // still answered. Failing this turn discarded a reply that was written —
    // and, when it had already been sent, told the sender it had not arrived.
    expect(
      isTurnSuccessful({
        status: 'ERROR',
        finalTextResponse: 'RECOVERED\n',
      })
    ).toBe(true);
  });

  it('treats a genuinely broken run as failure', () => {
    // Real capture from the unauthenticated smoke test: no response at all.
    expect(isTurnSuccessful({ status: 'ERROR', finalTextResponse: '' })).toBe(false);
    expect(isTurnSuccessful({ status: 'ERROR' })).toBe(false);
  });

  it('fails an UNKNOWN non-SUCCESS status even when it carries text', () => {
    // The property Lumen's blocker protects. A denylist of fatal statuses says
    // "anything I have not named is recoverable", which extends one measurement
    // to every status agy might add later — a future fatal status shipping a
    // diagnostic string would read as a completed turn. We have measured ERROR
    // and nothing else, so anything else fails by default.
    expect(
      isTurnSuccessful({ status: 'SOME_FUTURE_FATAL', finalTextResponse: 'a diagnostic string' })
    ).toBe(false);
    expect(isTurnSuccessful({ status: 'WAITING', finalTextResponse: 'partial' })).toBe(false);
    expect(isTurnSuccessful({ status: 'INVALID', finalTextResponse: 'partial' })).toBe(false);
  });

  it('keeps timeouts and crashes fatal even when partial text exists', () => {
    // These mean the run was STOPPED, so any text is partial by definition —
    // the opposite of a turn that ran to completion despite an error.
    expect(
      isTurnSuccessful({
        status: 'TIMEOUT',
        finalTextResponse: '[Process timed out after 300s idle]',
      })
    ).toBe(false);
    expect(isTurnSuccessful({ status: 'CRASH', finalTextResponse: 'partway through when' })).toBe(
      false
    );
    expect(isTurnSuccessful({ status: 'CANCELED', finalTextResponse: 'half an answer' })).toBe(
      false
    );
    expect(isTurnSuccessful({ status: 'INTERRUPTED', finalTextResponse: 'half an answer' })).toBe(
      false
    );
  });

  it('treats whitespace as no answer', () => {
    expect(isTurnSuccessful({ status: 'ERROR', finalTextResponse: '   \n  ' })).toBe(false);
  });

  it('passes SUCCESS and an absent status through', () => {
    expect(isTurnSuccessful({ status: 'SUCCESS', finalTextResponse: 'hi' })).toBe(true);
    expect(isTurnSuccessful({})).toBe(true);
  });
});

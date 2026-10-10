import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { CLAUDE_VERSION } from './config.js';
import { REQUIRED_FLAGS } from './claude.js';

export const MODEL = 'claude-synthetic-search';
export const SYNTHETIC_ENV: NodeJS.ProcessEnv = {
  INK_WEB_SEARCH_ENABLED: 'true',
  INK_WEB_SEARCH_PROVIDER: 'claude',
  INK_WEB_SEARCH_CLAUDE_PATH: '/synthetic/provider/claude',
  INK_WEB_SEARCH_MODEL: MODEL,
};
export const HELP = REQUIRED_FLAGS.map((flag) => `${flag} <value>`).join('\n');

export function searchEvents(
  query = 'synthetic query',
  urls = ['https://example.com/result']
): Record<string, unknown>[] {
  return [
    {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
      tools: ['WebSearch', 'EndConversation'],
      mcp_servers: [],
      plugins: [],
      model: MODEL,
      claude_code_version: CLAUDE_VERSION,
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query } }],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'search-1',
            content: 'Opaque native tool display text',
          },
        ],
      },
      tool_use_result: {
        query,
        results: [
          {
            tool_use_id: 'server-search-1',
            content: urls.map((url) => ({ title: 'Synthetic search hit', url })),
          },
        ],
        durationSeconds: 0.01,
        searchCount: 1,
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Ignored assistant prose',
      permission_denials: [],
      usage: { input_tokens: 42, output_tokens: 8 },
    },
  ];
}

/** All process and signal operations are inert; this class never spawns. */
export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  input = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  groupAlive = true;
  ignoreTerm = false;
  ignoreKill = false;
  signals: NodeJS.Signals[] = [];

  constructor(
    readonly pid: number,
    readonly args: string[],
    readonly options: SpawnOptions,
    respond: (child: FakeChild) => void
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.input += chunk.toString();
        callback();
      },
      final: (callback) => {
        callback();
        queueMicrotask(() => respond(this));
      },
    });
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if ((signal === 'SIGTERM' && this.ignoreTerm) || (signal === 'SIGKILL' && this.ignoreKill))
      return true;
    this.groupAlive = false;
    // Real child exit events arrive asynchronously. Matching that also lets
    // stopProcessAndWait install its escalation handle before seeing exit;
    // no timer may outlive the test's mocked process.kill boundary.
    if (this.exitCode === null && this.signalCode === null) {
      queueMicrotask(() => this.finish(null, signal));
    }
    return true;
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null, keepGroup = false): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.groupAlive = keepGroup;
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }

  events(events: Record<string, unknown>[]): void {
    for (const event of events) this.stdout.write(JSON.stringify(event) + '\n');
  }
}

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env', async () => ({
  env: (await import('../../test/fake-env')).fakeEnv,
  isDevelopment: () => false,
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(() => {
    throw new Error('No subprocess in this test');
  }),
  spawn: vi.fn(() => {
    throw new Error('No subprocess in this test');
  }),
}));

import { InkRunner } from './ink-runner';
import { inklingReplyPrompt } from '../inklings/inkling-runtime';

describe('InkRunner conversational result boundary', () => {
  const parse = (text: unknown) => {
    const runner = new InkRunner() as unknown as {
      parseOutput(stdout: string, stderr: string): { finalTextResponse?: string };
    };
    return runner.parseOutput(JSON.stringify({ type: 'result', text }), '');
  };

  it.each([
    null,
    42,
    '(local tool call emitted; see tool results above)',
    '<invoke name="signal_status"></invoke>',
    '```ink-tool\n{"tool":"signal_status","args":{"status":"completed"}}\n```',
  ])('never exposes control-only results as replies', (text) => {
    expect(parse(text).finalTextResponse).toBeUndefined();
  });

  it('preserves a normal answer and removes a trailing control', () => {
    expect(parse('  An invented answer.').finalTextResponse).toBe('  An invented answer.');
    expect(
      parse('An invented answer.\n<invoke name="signal_status"></invoke>').finalTextResponse
    ).toBe('An invented answer.');
  });

  it('names the common send tool and exact conversation in the targeted prompt', () => {
    const prompt = inklingReplyPrompt('chat:synthetic');
    expect(prompt).toContain('send_response');
    expect(prompt).toContain('"inkling"');
    expect(prompt).toContain('"chat:synthetic"');
    expect(prompt).toContain('signal_status');
    expect(inklingReplyPrompt(undefined)).toBe('');
  });
});

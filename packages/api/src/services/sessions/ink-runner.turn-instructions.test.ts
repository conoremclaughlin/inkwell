/**
 * The turn's own instructions reach an ink turn (task 9160180d). SessionService
 * composes an inkling's reply contract and the execution tier; ink has no
 * system-prompt-append path, so the runner carries them in the message, on the
 * fresh, resumed and supplied-context recovery attempts alike. Before this, a
 * smoke run's turn requests held no reply contract at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { InkRunner } from './ink-runner';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONTRACT =
  '### Replying in this Inkling conversation\nSend each conversational reply with send_response, channel: "inkling", conversationId: "chat:synthetic"';

function ctx() {
  return {
    agent: {
      sbSlug: 'pip',
      name: 'Pip',
      role: 'assistant',
      soul: 'SOUL-BODY',
      values: [],
      capabilities: [],
      relationships: {},
    },
    user: { id: 'u1', timezone: 'UTC', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '9:00 AM',
      currentDate: 'Monday, August 24, 2026',
      dayOfWeek: 'Monday',
      timezone: 'UTC',
      greeting: 'Good morning',
    },
    constitution: { values: 'VALUES-BODY', process: 'PROCESS-BODY', user: 'USER-BODY' },
    knowledgeSummary: 'DIGEST-BODY',
    recentMemories: [],
    activeProjects: [],
  } as never;
}

const cfg = (extra: Record<string, unknown> = {}) =>
  ({ workingDirectory: '/tmp', mcpConfigPath: '/tmp/.mcp.json', sbSlug: 'pip', ...extra }) as never;

/** Every message the runner spawned `ink chat` with, attempt by attempt. */
function recording(results: Array<Record<string, unknown>>) {
  const runner = new InkRunner();
  const messages: string[] = [];
  (runner as any).spawnProcess = vi.fn(async (_args: string[], message: string) => {
    messages.push(message);
    return { responses: [], toolCalls: [], ...(results[messages.length - 1] ?? {}) };
  });
  return { runner, messages };
}

describe('InkRunner: the turn instructions reach every attempt', () => {
  it('a fresh turn leads with them, and keeps its context and the message', async () => {
    const { runner, messages } = recording([{ finalTextResponse: 'ok' }]);
    await runner.run('hello there', {
      injectedContext: ctx(),
      config: cfg({ turnInstructions: CONTRACT }),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].startsWith(CONTRACT)).toBe(true);
    expect(messages[0]).toContain('hello there');
  });

  it('a resumed turn carries them too, though it carries no context', async () => {
    const { runner, messages } = recording([{ finalTextResponse: 'ok' }]);
    await runner.run('second message', {
      backendSessionId: 'existing-session',
      injectedContext: ctx(),
      config: cfg({ turnInstructions: CONTRACT }),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(CONTRACT);
    expect(messages[0]).toContain('second message');
    // Still lean: a resume does not bring the context back.
    expect(messages[0]).not.toContain('VALUES-BODY');
  });

  it('both attempts of a bootstrap recovery carry them', async () => {
    const { runner, messages } = recording([
      { bootstrapRequiredFailure: true },
      { finalTextResponse: 'recovered' },
    ]);
    const result = await runner.run('hello', {
      injectedContext: ctx(),
      config: cfg({ turnInstructions: CONTRACT }),
    });
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m).toContain(CONTRACT);
    expect(result.success).toBe(true);
  });

  it('a resume that finds no session restarts fresh with them', async () => {
    const { runner, messages } = recording([
      { resumeFailedNoSession: true },
      { finalTextResponse: 'ok' },
    ]);
    await runner.run('hello', {
      backendSessionId: 'gone-session',
      injectedContext: ctx(),
      config: cfg({ turnInstructions: CONTRACT }),
    });
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m).toContain(CONTRACT);
  });

  it('without instructions the message is exactly as before', async () => {
    const { runner, messages } = recording([{ finalTextResponse: 'ok' }]);
    await runner.run('plain', { config: cfg() });
    expect(messages).toEqual(['plain']);
  });
});

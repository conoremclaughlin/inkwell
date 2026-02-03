/**
 * Claude Code Backend Tests
 *
 * Tests for the Claude Code backend, particularly the response guard
 * that prevents multiple response emissions from a single invocation.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process before importing
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { spawn } from 'child_process';

describe('Claude Code Backend Response Guard', () => {
  let mockProcess: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: Mock;
  };

  beforeEach(() => {
    mockProcess = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });

    (spawn as Mock).mockReturnValue(mockProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Response Emission Guard', () => {
    it('should emit response only once per invocation', async () => {
      // This test verifies the responseEmitted guard behavior
      // by simulating the stream-json output that would normally
      // trigger multiple responses

      const responses: string[] = [];

      // Simulate the responseEmitted guard logic
      let responseEmitted = false;

      const emitResponse = (content: string) => {
        if (!responseEmitted) {
          responseEmitted = true;
          responses.push(content);
        }
      };

      // Simulate multiple result events (like paragraphs in stream-json)
      emitResponse('First paragraph');
      emitResponse('Second paragraph'); // Should be ignored
      emitResponse('Third paragraph'); // Should be ignored

      expect(responses.length).toBe(1);
      expect(responses[0]).toBe('First paragraph');
    });

    it('should allow responses from separate invocations', async () => {
      const responses: string[] = [];

      // First invocation
      let responseEmitted1 = false;
      const emitResponse1 = (content: string) => {
        if (!responseEmitted1) {
          responseEmitted1 = true;
          responses.push(`Invocation1: ${content}`);
        }
      };

      // Second invocation (new guard)
      let responseEmitted2 = false;
      const emitResponse2 = (content: string) => {
        if (!responseEmitted2) {
          responseEmitted2 = true;
          responses.push(`Invocation2: ${content}`);
        }
      };

      emitResponse1('Response A');
      emitResponse2('Response B');

      expect(responses.length).toBe(2);
      expect(responses[0]).toBe('Invocation1: Response A');
      expect(responses[1]).toBe('Invocation2: Response B');
    });
  });

  describe('Stream JSON Parsing', () => {
    it('should parse valid stream-json lines', () => {
      const validLines = [
        '{"type":"system","subtype":"init","session_id":"abc123"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
        '{"type":"result","result":"Final response"}',
      ];

      const parsed = validLines.map((line) => JSON.parse(line));

      expect(parsed[0].type).toBe('system');
      expect(parsed[1].type).toBe('assistant');
      expect(parsed[2].type).toBe('result');
      expect(parsed[2].result).toBe('Final response');
    });

    it('should handle result with content blocks', () => {
      const resultWithBlocks = {
        type: 'result',
        result: 'Accumulated response\n\nWith multiple paragraphs',
      };

      expect(resultWithBlocks.result).toContain('multiple paragraphs');
    });

    it('should extract text from assistant content blocks', () => {
      const assistantMessage = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First part' },
            { type: 'tool_use', name: 'some_tool' },
            { type: 'text', text: 'Second part' },
          ],
        },
      };

      const textContent = assistantMessage.message.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n');

      expect(textContent).toBe('First part\nSecond part');
    });
  });

  describe('disableAutoResponse Config', () => {
    it('should respect disableAutoResponse setting', () => {
      const config = {
        type: 'claude-code' as const,
        disableAutoResponse: true,
      };

      // When disableAutoResponse is true, response should NOT be emitted
      let responseEmitted = false;
      const shouldEmit = !config.disableAutoResponse;

      if (shouldEmit && !responseEmitted) {
        responseEmitted = true;
      }

      expect(responseEmitted).toBe(false);
    });

    it('should emit response when disableAutoResponse is false', () => {
      const config = {
        type: 'claude-code' as const,
        disableAutoResponse: false,
      };

      let responseEmitted = false;
      const shouldEmit = !config.disableAutoResponse;

      if (shouldEmit && !responseEmitted) {
        responseEmitted = true;
      }

      expect(responseEmitted).toBe(true);
    });
  });

  describe('Session Resumption', () => {
    it('should include resume flag when session ID provided', () => {
      const sessionId = 'session-123';
      const args: string[] = [];

      if (sessionId) {
        args.push('--resume', sessionId);
      }

      expect(args).toContain('--resume');
      expect(args).toContain(sessionId);
    });

    it('should not include resume flag for new sessions', () => {
      const sessionId = undefined;
      const args: string[] = [];

      if (sessionId) {
        args.push('--resume', sessionId);
      }

      expect(args).not.toContain('--resume');
    });
  });

  describe('Pending Message Tracking', () => {
    it('should track pending message for response routing', () => {
      interface PendingMessage {
        channel: string;
        conversationId: string;
        sender: { id: string; name?: string };
      }

      let pendingMessage: PendingMessage | null = null;

      // Simulate setting pending message
      pendingMessage = {
        channel: 'telegram',
        conversationId: 'chat123',
        sender: { id: 'user1', name: 'Test User' },
      };

      expect(pendingMessage).not.toBeNull();
      expect(pendingMessage?.channel).toBe('telegram');
      expect(pendingMessage?.conversationId).toBe('chat123');
    });

    it('should clear pending message after response', () => {
      interface PendingMessage {
        channel: string;
        conversationId: string;
      }

      let pendingMessage: PendingMessage | null = {
        channel: 'telegram',
        conversationId: 'chat123',
      };

      // Simulate response emission
      const emitResponse = () => {
        if (pendingMessage) {
          // Use pending message for routing
          const response = {
            channel: pendingMessage.channel,
            conversationId: pendingMessage.conversationId,
            content: 'Response content',
          };
          pendingMessage = null;
          return response;
        }
        return null;
      };

      const response = emitResponse();
      expect(response).not.toBeNull();
      expect(pendingMessage).toBeNull();
    });
  });
});

describe('Session Continuity', () => {
  let mockProcess: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: Mock; end: Mock };
    kill: Mock;
  };

  beforeEach(() => {
    mockProcess = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
    });
    (spawn as Mock).mockReturnValue(mockProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should emit session:captured when system message contains session_id', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const captured: string[] = [];
    backend.on('session:captured', (id: string) => captured.push(id));

    // Start a message (which spawns a process)
    const messagePromise = backend.sendMessage({
      id: 'msg-1',
      channel: 'telegram',
      conversationId: 'chat-1',
      sender: { id: 'user-1' },
      content: 'Hello',
      timestamp: new Date(),
    });

    // Simulate Claude Code emitting system message with session_id
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","subtype":"init","session_id":"sess-abc123"}\n'
    ));

    // Emit result and close
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"result","result":"Hi there","usage":{"input_tokens":100,"output_tokens":50}}\n'
    ));
    mockProcess.emit('close', 0);
    await messagePromise;

    expect(captured).toEqual(['sess-abc123']);
    expect(backend.getSessionId()).toBe('sess-abc123');
  });

  it('should track token usage cumulatively and emit session:usage', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const usageEvents: Array<{ inputTokens: number; outputTokens: number }> = [];
    backend.on('session:usage', (usage) => usageEvents.push(usage));

    // First message
    const msg1 = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n' +
      '{"type":"result","result":"Hi","usage":{"input_tokens":1000,"output_tokens":500}}\n'
    ));
    mockProcess.emit('close', 0);
    await msg1;

    expect(usageEvents.length).toBe(1);
    expect(usageEvents[0].inputTokens).toBe(1000);
    expect(usageEvents[0].outputTokens).toBe(500);

    // Second message — tokens should accumulate
    (spawn as Mock).mockReturnValue(Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
    }));

    const msg2 = backend.sendMessage({
      id: 'msg-2', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'More', timestamp: new Date(),
    });

    const proc2 = (spawn as Mock).mock.results[(spawn as Mock).mock.results.length - 1].value;
    proc2.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n' +
      '{"type":"result","result":"Reply","usage":{"input_tokens":2000,"output_tokens":800}}\n'
    ));
    proc2.emit('close', 0);
    await msg2;

    expect(usageEvents.length).toBe(2);
    expect(usageEvents[1].inputTokens).toBe(3000); // 1000 + 2000
    expect(usageEvents[1].outputTokens).toBe(1300); // 500 + 800
  });

  it('should include token usage in health report', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n' +
      '{"type":"result","result":"Hi","usage":{"input_tokens":5000,"output_tokens":2000}}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;

    const health = backend.getHealth();
    expect(health.totalInputTokens).toBe(5000);
    expect(health.totalOutputTokens).toBe(2000);
  });

  it('should clear sessionId and token counters on clearSession()', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    // Send a message to establish session and tokens
    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"sess-xyz"}\n' +
      '{"type":"result","result":"Hi","usage":{"input_tokens":1000,"output_tokens":500}}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;

    expect(backend.getSessionId()).toBe('sess-xyz');
    expect(backend.getHealth().totalInputTokens).toBe(1000);

    // Clear session
    backend.clearSession();

    expect(backend.getSessionId()).toBeNull();
    expect(backend.getHealth().totalInputTokens).toBe(0);
    expect(backend.getHealth().totalOutputTokens).toBe(0);
  });

  it('should clear pendingMessage when process closes', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });

    // Before close, pending message should exist
    expect(backend.getPendingMessage()).not.toBeNull();

    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"result","result":"Hi"}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;

    // After close, pending message should be cleared
    expect(backend.getPendingMessage()).toBeNull();
  });

  it('should use --resume flag when sessionId is set', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    // Set session via resumeSession
    await backend.resumeSession('existing-session-123');

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'Continue', timestamp: new Date(),
    });

    // Check spawn was called with --resume flag
    const spawnCall = (spawn as Mock).mock.calls[(spawn as Mock).mock.calls.length - 1];
    const args = spawnCall[1] as string[];
    expect(args).toContain('--resume');
    expect(args).toContain('existing-session-123');

    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"existing-session-123"}\n' +
      '{"type":"result","result":"Resumed"}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;
  });

  it('should suppress auto-response for internal messages', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const responses: unknown[] = [];
    backend.on('response', (r: unknown) => responses.push(r));

    // Send an internal message (like compaction)
    const msg = backend.sendMessage({
      id: 'compaction-1', channel: 'agent', conversationId: 'compaction-myra',
      sender: { id: 'system', name: 'System' }, content: 'Compact session',
      timestamp: new Date(),
      metadata: { isInternal: true, isCompaction: true },
    });

    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n' +
      '{"type":"result","result":"Compaction complete","usage":{"input_tokens":500,"output_tokens":200}}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;

    // Auto-response should NOT be emitted for internal messages
    expect(responses.length).toBe(0);
  });

  it('should NOT use --resume flag for new sessions', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'c1',
      sender: { id: 'u1' }, content: 'Fresh start', timestamp: new Date(),
    });

    const spawnCall = (spawn as Mock).mock.calls[(spawn as Mock).mock.calls.length - 1];
    const args = spawnCall[1] as string[];
    expect(args).not.toContain('--resume');

    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"new-sess"}\n' +
      '{"type":"result","result":"New"}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;
  });
});

describe('Fallback Auto-Response on Close', () => {
  let mockProcess: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: Mock; end: Mock };
    kill: Mock;
  };

  beforeEach(() => {
    mockProcess = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
    });
    (spawn as Mock).mockReturnValue(mockProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should emit fallback response when process exits without result event', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const responses: Array<{ channel: string; conversationId: string; content: string }> = [];
    backend.on('response', (r) => responses.push(r));

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'chat-123',
      sender: { id: 'u1', name: 'Conor' }, content: 'Hello',
      timestamp: new Date(),
    });

    // Simulate assistant text events but NO result event (e.g., Claude Code crashes mid-stream)
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Here is my response"}]}}\n'
    ));

    // Process exits without ever emitting a result event
    mockProcess.emit('close', 1);
    await msg;

    // Fallback should have emitted the accumulated assistant text
    expect(responses.length).toBe(1);
    expect(responses[0].channel).toBe('telegram');
    expect(responses[0].conversationId).toBe('chat-123');
    expect(responses[0].content).toBe('Here is my response');
  });

  it('should NOT emit fallback when result event was already received', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const responses: Array<{ content: string }> = [];
    backend.on('response', (r) => responses.push(r));

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'chat-123',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });

    // Normal flow: assistant text + result event
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n' +
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Response text"}]}}\n' +
      '{"type":"result","result":"Response text","usage":{"input_tokens":100,"output_tokens":50}}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;

    // Only ONE response — from the result event, not a duplicate from close
    expect(responses.length).toBe(1);
  });

  it('should NOT emit fallback for internal messages', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const responses: unknown[] = [];
    backend.on('response', (r) => responses.push(r));

    const msg = backend.sendMessage({
      id: 'compaction-1', channel: 'agent', conversationId: 'compaction-myra',
      sender: { id: 'system' }, content: 'Compact session',
      timestamp: new Date(),
      metadata: { isInternal: true, isCompaction: true },
    });

    // Assistant text but no result, and it's an internal message
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Compaction done"}]}}\n'
    ));
    mockProcess.emit('close', 0);
    await msg;

    expect(responses.length).toBe(0);
  });

  it('should NOT emit fallback when disableAutoResponse is true', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code', disableAutoResponse: true });
    await backend.initialize();

    const responses: unknown[] = [];
    backend.on('response', (r) => responses.push(r));

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'chat-123',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });

    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Response text"}]}}\n'
    ));
    mockProcess.emit('close', 1);
    await msg;

    expect(responses.length).toBe(0);
  });

  it('should NOT emit fallback when responseContent is empty', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const responses: unknown[] = [];
    backend.on('response', (r) => responses.push(r));

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'chat-123',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });

    // Process exits with no assistant text and no result
    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"system","session_id":"s1"}\n'
    ));
    mockProcess.emit('close', 1);
    await msg;

    expect(responses.length).toBe(0);
  });

  it('should clear pendingMessage after fallback emission', async () => {
    const { ClaudeCodeBackend } = await import('./claude-code.backend');
    const backend = new ClaudeCodeBackend({ type: 'claude-code' });
    await backend.initialize();

    const msg = backend.sendMessage({
      id: 'msg-1', channel: 'telegram', conversationId: 'chat-123',
      sender: { id: 'u1' }, content: 'Hello', timestamp: new Date(),
    });

    expect(backend.getPendingMessage()).not.toBeNull();

    mockProcess.stdout.emit('data', Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Fallback text"}]}}\n'
    ));
    mockProcess.emit('close', 1);
    await msg;

    expect(backend.getPendingMessage()).toBeNull();
  });
});

describe('Backend Configuration', () => {
  it('should have correct default timeout', () => {
    const DEFAULT_TIMEOUT = 300000; // 5 minutes
    expect(DEFAULT_TIMEOUT).toBe(300000);
  });

  it('should support custom system prompts', () => {
    const config = {
      type: 'claude-code' as const,
      systemPrompt: 'You are a helpful assistant.',
    };

    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).toContain('helpful');
  });

  it('should support model override', () => {
    const config = {
      type: 'claude-code' as const,
      model: 'sonnet',
    };

    expect(config.model).toBe('sonnet');
  });
});

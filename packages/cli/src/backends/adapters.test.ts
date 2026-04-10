import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { buildIdentityPrompt } from './identity.js';
import { decodeContextToken } from '@inklabs/shared';

describe('buildIdentityPrompt conditional bootstrap', () => {
  it('includes conditional self-healing instructions when no startup context is provided', () => {
    const prompt = buildIdentityPrompt('wren');

    expect(prompt).toContain('You are wren');
    // Should tell agent to check for existing docs first, not bootstrap unconditionally
    expect(prompt).toContain('check whether your constitution docs are already present');
    expect(prompt).toContain('If these are present');
    expect(prompt).toContain('do NOT call bootstrap again');
    expect(prompt).toContain('If these are NOT present');
    expect(prompt).toContain('call the `bootstrap` MCP tool manually');
    expect(prompt).not.toContain('Bootstrap has already been completed');
    // Should NOT unconditionally instruct bootstrap
    expect(prompt).not.toContain('Skip directly to loading user config');
    // Should NOT have the actual startup context section
    expect(prompt).not.toContain('## Bootstrapped Startup Context (PCP)');
  });

  it('skips manual bootstrap when startup context is provided', () => {
    const prompt = buildIdentityPrompt('lumen', '### Identity\nI am Lumen.');

    expect(prompt).toContain('You are lumen');
    expect(prompt).toContain('Bootstrap has already been completed');
    expect(prompt).toContain('Do NOT call bootstrap again');
    expect(prompt).toContain('## Bootstrapped Startup Context (PCP)');
    expect(prompt).toContain('### Identity');
    expect(prompt).toContain('I am Lumen.');
    expect(prompt).not.toContain('check whether your constitution docs are already present');
  });
});

describe('backend adapters session resume wiring', () => {
  it('passes claude backendSessionId through --resume', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      backendSessionId: 'claude-session-789',
    });

    expect(prepared.args).toContain('--resume');
    expect(prepared.args).toContain('claude-session-789');
  });

  it('does not force claude --session-id from pcp session id', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-session-123',
    });

    expect(prepared.args).not.toContain('--session-id');
    expect(prepared.args).not.toContain('pcp-session-123');
  });

  it('passes claude backendSessionSeedId through --session-id', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-session-123',
      backendSessionSeedId: 'pcp-session-123',
    });

    const sessionIdFlagIndex = prepared.args.indexOf('--session-id');
    expect(sessionIdFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.args[sessionIdFlagIndex + 1]).toBe('pcp-session-123');
  });

  it('passes backendSessionId through codex resume subcommand', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: ['continue', 'work'],
      passthroughArgs: [],
      backendSessionId: 'codex-session-123',
    });

    try {
      expect(prepared.args).toContain('resume');
      expect(prepared.args).toContain('codex-session-123');
    } finally {
      prepared.cleanup();
    }
  });

  it('places codex passthrough args after exec subcommand', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: ['exec', 'do work'],
      passthroughArgs: ['--sandbox', 'read-only', '--skip-git-repo-check'],
    });

    try {
      const execIndex = prepared.args.indexOf('exec');
      expect(execIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.args.slice(execIndex, execIndex + 5)).toEqual([
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        'do work',
      ]);
    } finally {
      prepared.cleanup();
    }
  });

  it('injects startup context into codex model instructions file when provided', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      startupContextBlock: '### STARTUP TEST\nInjected from bootstrap.',
    });

    try {
      const modelInstructionsArg = prepared.args.find((arg) =>
        arg.startsWith('model_instructions_file=')
      );
      expect(modelInstructionsArg).toBeDefined();
      const promptPath = modelInstructionsArg!.slice('model_instructions_file='.length);
      const promptBody = readFileSync(promptPath, 'utf-8');
      expect(promptBody).toContain('## Bootstrapped Startup Context (PCP)');
      expect(promptBody).toContain('### STARTUP TEST');
      expect(promptBody).toContain('Injected from bootstrap.');
    } finally {
      prepared.cleanup();
    }
  });

  it('maps --dangerous to claude --dangerously-skip-permissions', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      dangerous: true,
    });

    expect(prepared.args).toContain('--dangerously-skip-permissions');
  });

  it('maps --dangerous to codex --dangerously-bypass-approvals-and-sandbox', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      dangerous: true,
    });

    try {
      expect(prepared.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      prepared.cleanup();
    }
  });

  it('maps --dangerous to gemini --yolo', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      dangerous: true,
    });

    try {
      expect(prepared.args).toContain('--yolo');
    } finally {
      prepared.cleanup();
    }
  });

  it('does not add auto-approve flags when dangerous is false', () => {
    const claude = new ClaudeAdapter();
    const claudePrep = claude.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
    });
    expect(claudePrep.args).not.toContain('--dangerously-skip-permissions');

    const codex = new CodexAdapter();
    const codexPrep = codex.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
    });
    try {
      expect(codexPrep.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    } finally {
      codexPrep.cleanup();
    }

    const gemini = new GeminiAdapter();
    const geminiPrep = gemini.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
    });
    try {
      expect(geminiPrep.args).not.toContain('--yolo');
    } finally {
      geminiPrep.cleanup();
    }
  });

  // ── INK_SESSION_ID env propagation ──
  // These tests verify the most fragile link in the session identity chain:
  // the CLI backends must inject INK_SESSION_ID into the spawned process's
  // environment so hooks + buildMergedMcpConfig can propagate it to the server.

  it('injects INK_SESSION_ID into claude env when pcpSessionId is provided', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-sess-abc-123',
    });

    expect(prepared.env).toBeDefined();
    expect(prepared.env!.INK_SESSION_ID).toBe('pcp-sess-abc-123');
  });

  it('does not inject INK_SESSION_ID into claude env when pcpSessionId is absent', () => {
    const adapter = new ClaudeAdapter();
    const prepared = adapter.prepare({
      agentId: 'wren',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
    });

    expect(prepared.env?.INK_SESSION_ID).toBeUndefined();
  });

  it('injects INK_SESSION_ID into codex env when pcpSessionId is provided', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-sess-def-456',
    });

    try {
      expect(prepared.env).toBeDefined();
      expect(prepared.env!.INK_SESSION_ID).toBe('pcp-sess-def-456');
    } finally {
      prepared.cleanup();
    }
  });

  it('does not inject INK_SESSION_ID into codex env when pcpSessionId is absent', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
    });

    try {
      expect(prepared.env?.INK_SESSION_ID).toBeUndefined();
    } finally {
      prepared.cleanup();
    }
  });

  it('injects INK_SESSION_ID into gemini env when pcpSessionId is provided', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'pcp-sess-ghi-789',
    });

    try {
      expect(prepared.env).toBeDefined();
      expect(prepared.env!.INK_SESSION_ID).toBe('pcp-sess-ghi-789');
    } finally {
      prepared.cleanup();
    }
  });

  it('does not inject INK_SESSION_ID into gemini env when pcpSessionId is absent', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
    });

    try {
      expect(prepared.env?.INK_SESSION_ID).toBeUndefined();
    } finally {
      prepared.cleanup();
    }
  });

  it('injects both AGENT_ID and INK_SESSION_ID into all backend envs', () => {
    const configs = [
      { adapter: new ClaudeAdapter(), agentId: 'wren', cleanup: false },
      { adapter: new CodexAdapter(), agentId: 'lumen', cleanup: true },
      { adapter: new GeminiAdapter(), agentId: 'aster', cleanup: true },
    ] as const;

    for (const { adapter, agentId, cleanup } of configs) {
      const prepared = (adapter as { prepare: typeof ClaudeAdapter.prototype.prepare }).prepare({
        agentId,
        model: undefined,
        promptParts: [],
        passthroughArgs: [],
        pcpSessionId: 'pcp-sess-shared',
      });

      try {
        expect(prepared.env).toBeDefined();
        expect(prepared.env!.AGENT_ID).toBe(agentId);
        expect(prepared.env!.INK_SESSION_ID).toBe('pcp-sess-shared');
      } finally {
        if (cleanup) prepared.cleanup();
      }
    }
  });

  it('passes backendSessionId through gemini --resume flag', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      backendSessionId: 'gemini-session-456',
    });

    try {
      const resumeFlagIndex = prepared.args.indexOf('--resume');
      expect(resumeFlagIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.args[resumeFlagIndex + 1]).toBe('gemini-session-456');
    } finally {
      prepared.cleanup();
    }
  });

  // ── INK_CONTEXT_TOKEN + auth header regression ──
  // Codex and Gemini adapters must produce INK_CONTEXT_TOKEN in env and
  // wire x-ink-context + Authorization via env_http_headers. Without these,
  // MCP tool calls go to PCP unauthenticated and without session context,
  // causing "Session context missing — triggers suppressed."

  it('codex adapter produces INK_CONTEXT_TOKEN with session/studio/agent', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'sess-codex-123',
      studioId: 'studio-lumen-456',
    });

    try {
      expect(prepared.env.INK_CONTEXT_TOKEN).toBeDefined();
      const token = decodeContextToken(prepared.env.INK_CONTEXT_TOKEN);
      expect(token).not.toBeNull();
      expect(token!.sessionId).toBe('sess-codex-123');
      expect(token!.studioId).toBe('studio-lumen-456');
      expect(token!.agentId).toBe('lumen');
      expect(token!.runtime).toBe('codex');
      expect(token!.cliAttached).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  it('codex adapter injects x-ink-context and Authorization env_http_headers', () => {
    const adapter = new CodexAdapter();
    const prepared = adapter.prepare({
      agentId: 'lumen',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'sess-codex-123',
    });

    try {
      const contextArg = prepared.args.find((a) => a.includes('x-ink-context'));
      expect(contextArg).toBeDefined();
      expect(contextArg).toContain('INK_CONTEXT_TOKEN');

      const authArg = prepared.args.find((a) => a.includes('Authorization'));
      expect(authArg).toBeDefined();
      expect(authArg).toContain('INK_AUTH_BEARER');
    } finally {
      prepared.cleanup();
    }
  });

  it('gemini adapter produces INK_CONTEXT_TOKEN with session/studio/agent', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'sess-gemini-789',
      studioId: 'studio-aster-012',
    });

    try {
      expect(prepared.env.INK_CONTEXT_TOKEN).toBeDefined();
      const token = decodeContextToken(prepared.env.INK_CONTEXT_TOKEN);
      expect(token).not.toBeNull();
      expect(token!.sessionId).toBe('sess-gemini-789');
      expect(token!.studioId).toBe('studio-aster-012');
      expect(token!.agentId).toBe('aster');
      expect(token!.runtime).toBe('gemini');
      expect(token!.cliAttached).toBe(true);
    } finally {
      prepared.cleanup();
    }
  });

  it('gemini adapter generates settings.json with auth + context headers', () => {
    const adapter = new GeminiAdapter();
    const prepared = adapter.prepare({
      agentId: 'aster',
      model: undefined,
      promptParts: [],
      passthroughArgs: [],
      pcpSessionId: 'sess-gemini-789',
    });

    try {
      // Should have GEMINI_CLI_SYSTEM_SETTINGS_PATH pointing to temp file
      expect(prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeDefined();
      const settingsContent = readFileSync(prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(settingsContent);

      // PCP server should have auth + context headers
      expect(settings.mcpServers.inkwell).toBeDefined();
      expect(settings.mcpServers.inkwell.headers.Authorization).toBe('Bearer ${INK_ACCESS_TOKEN}');
      expect(settings.mcpServers.inkwell.headers['x-ink-context']).toBe('${INK_CONTEXT_TOKEN}');
      expect(settings.mcpServers.inkwell.headers['x-ink-session-id']).toBe('${INK_SESSION_ID}');
    } finally {
      prepared.cleanup();
    }
  });
});

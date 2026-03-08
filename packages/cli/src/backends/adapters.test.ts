import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';

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
});

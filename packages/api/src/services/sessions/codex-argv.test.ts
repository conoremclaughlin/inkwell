import { describe, expect, it, vi } from 'vitest';
vi.mock('../../config/env.js', () => ({ env: { MCP_HTTP_PORT: 4001 } }));
vi.mock('../../utils/logger.js', () => ({ logger: {} }));
vi.mock('../studio-paths.js', () => ({ inkStudiosRoot: () => '/synthetic/studios' }));
import { CodexRunner } from './codex-runner';
import type { ClaudeRunnerConfig } from './types';

// Guard/argument-builder probes only. No payload is sent through an executor.
describe('remote Codex prompts remain positional data', () => {
  it.each(['--config=synthetic.option=true', '--help', 'resume', 'review', 'hello world'])(
    'terminates options before a fresh or resumed prompt: %s',
    (prompt) => {
      const builder = new CodexRunner() as unknown as {
        buildArgs(
          id: string | undefined,
          resume: boolean,
          message: string,
          config: ClaudeRunnerConfig,
          path: string
        ): string[];
      };
      const config = { workingDirectory: '/synthetic/workspace', mcpConfigPath: '' };
      expect(
        builder.buildArgs(undefined, false, prompt, config, '/synthetic/prompt.md').slice(-2)
      ).toEqual(['--', prompt]);
      expect(
        builder
          .buildArgs('synthetic-session', true, prompt, config, '/synthetic/prompt.md')
          .slice(-3)
      ).toEqual(['--', 'synthetic-session', prompt]);
    }
  );
});

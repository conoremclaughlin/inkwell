/**
 * Live tests for SandboxOrchestrator.
 *
 * These tests spin up real Docker containers and make real LLM API calls.
 * They require:
 * - Docker daemon running
 * - The inkwell:studio-sandbox image built
 * - Active Claude Code session (OAuth tokens staged from macOS keychain)
 * - Inkwell server running on localhost:3001 (for MCP connectivity test)
 *
 * Container reuse:
 *   A shared fixture container (ink-test-sandbox-live) is spun up once
 *   with credentials mounted and reused across all tests. Set
 *   INK_PERSIST_TEST_CONTAINER=1 to keep it alive after the run.
 *
 *   To tear it down manually: docker rm -f ink-test-sandbox-live
 *
 * Run with: INK_LIVE_TESTS=1 npx vitest run --config vitest.integration.config.ts src/services/sandbox/orchestrator.live.integration.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SandboxOrchestrator, type SandboxSpinUpRequest } from './orchestrator';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function imageExists(image: string): boolean {
  const result = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  return result.status === 0;
}

function claudeCredentialsAvailable(): boolean {
  const credFile = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credFile)) return true;
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function inkwellReachable(): boolean {
  try {
    execFileSync('curl', ['-sf', '-o', '/dev/null', 'http://localhost:3001/health'], {
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}

const SKIP =
  process.env.INK_LIVE_TESTS !== '1' ||
  !dockerAvailable() ||
  !imageExists('inkwell:studio-sandbox');

const PERSIST = process.env.INK_PERSIST_TEST_CONTAINER === '1';
const FIXTURE_NAME = 'ink-test-sandbox-live';
// Stable path so persisted containers' mounts match across runs
const FIXTURE_DIR = join(homedir(), '.ink', 'test-fixtures', 'sandbox-live');

describe.skipIf(SKIP)('SandboxOrchestrator (live)', () => {
  let orchestrator: SandboxOrchestrator;
  let testDir: string;
  let fixtureWasPreExisting = false;

  beforeAll(async () => {
    orchestrator = new SandboxOrchestrator();
    testDir = FIXTURE_DIR;
    mkdirSync(testDir, { recursive: true });

    // Refresh test files each run (idempotent)
    writeFileSync(join(testDir, 'README.md'), '# Test Project\n\nThis is a sandbox live test.\n');
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(
      join(testDir, 'src', 'hello.ts'),
      'export function greet() { return "hello"; }\n'
    );
    // Clean up output files from prior runs
    try {
      rmSync(join(testDir, 'sandbox-output.txt'));
    } catch {}

    // Create .mcp.json with inkwell (HTTP) + a stdio server to verify stripping
    writeFileSync(
      join(testDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            inkwell: { type: 'http', url: 'http://localhost:3001/mcp' },
            playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
          },
        },
        null,
        2
      )
    );

    // Spin up or reuse the shared fixture container (with credentials)
    fixtureWasPreExisting = await orchestrator.isRunning(FIXTURE_NAME);
    if (!fixtureWasPreExisting) {
      const result = await orchestrator.spinUp({
        userId: 'live-test-user',
        agentId: 'live-test-agent',
        studioId: 'studio-live-fixture',
        studioSlug: 'live',
        worktreePath: testDir,
        repoRoot: testDir,
        backendAuth: ['claude'],
        containerName: FIXTURE_NAME,
      });
      expect(result.success).toBe(true);
    }
  });

  afterAll(async () => {
    if (!PERSIST && !fixtureWasPreExisting) {
      await orchestrator.stop(FIXTURE_NAME).catch(() => {});
    }
  });

  describe('worktree manipulation', () => {
    it('agent can read and write files in the mounted studio', async () => {
      const { stdout: readResult } = await orchestrator.exec(FIXTURE_NAME, [
        'cat',
        '/studio/README.md',
      ]);
      expect(readResult).toContain('Test Project');

      await orchestrator.exec(FIXTURE_NAME, [
        'bash',
        '-c',
        'echo "created by sandbox" > /studio/sandbox-output.txt',
      ]);

      const hostPath = join(testDir, 'sandbox-output.txt');
      expect(existsSync(hostPath)).toBe(true);
      expect(readFileSync(hostPath, 'utf-8').trim()).toBe('created by sandbox');
    }, 10_000);

    it('agent can modify existing source files', async () => {
      await orchestrator.exec(FIXTURE_NAME, [
        'bash',
        '-c',
        'echo \'export function farewell() { return "goodbye"; }\' >> /studio/src/hello.ts',
      ]);

      const content = readFileSync(join(testDir, 'src', 'hello.ts'), 'utf-8');
      expect(content).toContain('farewell');
      expect(content).toContain('greet');
    }, 10_000);
  });

  describe('MCP config patching', () => {
    it('patched config contains only HTTP servers with rewritten URLs', async () => {
      const { stdout } = await orchestrator.exec(FIXTURE_NAME, ['cat', '/studio/.mcp.json']);
      const config = JSON.parse(stdout);

      expect(config.mcpServers.inkwell).toBeDefined();
      expect(config.mcpServers.inkwell.url).toContain('host.docker.internal');
      expect(config.mcpServers.playwright).toBeUndefined();
    }, 10_000);
  });

  describe('LLM response', () => {
    const SKIP_LLM = !claudeCredentialsAvailable();

    it.skipIf(SKIP_LLM)(
      'gets a live Claude response inside the container',
      async () => {
        const { stdout } = await orchestrator.exec(FIXTURE_NAME, [
          'claude',
          '--print',
          '--model',
          'claude-haiku-4-5-20251001',
          'What is 2+2? Reply with just the number.',
        ]);

        expect(stdout.trim().length).toBeGreaterThan(0);
        expect(stdout).toContain('4');
      },
      120_000
    );

    it.skipIf(SKIP_LLM)(
      'Claude can read workspace files via coding tools',
      async () => {
        const { stdout } = await orchestrator.exec(FIXTURE_NAME, [
          'claude',
          '--print',
          '--model',
          'claude-haiku-4-5-20251001',
          '--allowedTools',
          'Read',
          '-p',
          'Read the file src/hello.ts and tell me what function it exports. Reply with just the function name.',
        ]);

        expect(stdout.toLowerCase()).toContain('greet');
      },
      120_000
    );
  });

  describe('Inkwell MCP access', () => {
    const SKIP_INKWELL = !inkwellReachable();

    it.skipIf(SKIP_INKWELL)(
      'container can reach Inkwell server via host.docker.internal',
      async () => {
        const { stdout } = await orchestrator.exec(FIXTURE_NAME, [
          'curl',
          '-sf',
          'http://host.docker.internal:3001/health',
        ]);

        expect(stdout.length).toBeGreaterThan(0);
      },
      10_000
    );
  });
});

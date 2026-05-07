/**
 * Live tests for SandboxOrchestrator.
 *
 * These tests spin up real Docker containers and make real LLM API calls.
 * They require:
 * - Docker daemon running
 * - The inkwell:studio-sandbox image built
 * - ANTHROPIC_API_KEY set (for Claude calls)
 * - Inkwell server running on localhost:3001 (for MCP tests)
 *
 * Run with: INK_LIVE_TESTS=1 npx vitest run --config vitest.integration.config.ts src/services/sandbox/orchestrator.live.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SandboxOrchestrator, buildContainerName, type SandboxSpinUpRequest } from './orchestrator';

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

describe.skipIf(SKIP)('SandboxOrchestrator (live)', () => {
  let orchestrator: SandboxOrchestrator;
  let testDir: string;
  const containersToCleanup: string[] = [];

  beforeAll(() => {
    orchestrator = new SandboxOrchestrator();
    testDir = mkdtempSync(join(tmpdir(), 'sandbox-live-'));

    // Create a minimal studio with files to manipulate
    writeFileSync(join(testDir, 'README.md'), '# Test Project\n\nThis is a sandbox live test.\n');
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(
      join(testDir, 'src', 'hello.ts'),
      'export function greet() { return "hello"; }\n'
    );

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
  });

  afterAll(async () => {
    for (const name of containersToCleanup) {
      await orchestrator.stop(name).catch(() => {});
    }
  });

  function makeRequest(overrides: Partial<SandboxSpinUpRequest> = {}): SandboxSpinUpRequest {
    return {
      userId: 'live-test-user',
      agentId: 'live-test-agent',
      studioId: `studio-live-${Date.now()}`,
      studioSlug: 'live',
      worktreePath: testDir,
      repoRoot: testDir,
      backendAuth: ['claude'],
      extraEnv: {
        // Pass API key into the container for Claude calls
        ...(process.env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
          : {}),
      },
      ...overrides,
    };
  }

  describe('worktree manipulation', () => {
    it('agent can read and write files in the mounted studio', async () => {
      const request = makeRequest({ studioSlug: 'live-worktree' });
      const containerName = buildContainerName(request);
      containersToCleanup.push(containerName);

      await orchestrator.spinUp(request);

      // Read existing file
      const { stdout: readResult } = await orchestrator.exec(containerName, [
        'cat',
        '/studio/README.md',
      ]);
      expect(readResult).toContain('Test Project');

      // Write a new file
      await orchestrator.exec(containerName, [
        'bash',
        '-c',
        'echo "created by sandbox" > /studio/sandbox-output.txt',
      ]);

      // Verify file exists on the host (bind mount = shared filesystem)
      const hostPath = join(testDir, 'sandbox-output.txt');
      expect(existsSync(hostPath)).toBe(true);
      expect(readFileSync(hostPath, 'utf-8').trim()).toBe('created by sandbox');
    }, 30_000);

    it('agent can modify existing source files', async () => {
      const request = makeRequest({ studioSlug: 'live-modify' });
      const containerName = buildContainerName(request);
      containersToCleanup.push(containerName);

      await orchestrator.spinUp(request);

      // Append to an existing file
      await orchestrator.exec(containerName, [
        'bash',
        '-c',
        'echo \'export function farewell() { return "goodbye"; }\' >> /studio/src/hello.ts',
      ]);

      const content = readFileSync(join(testDir, 'src', 'hello.ts'), 'utf-8');
      expect(content).toContain('farewell');
      expect(content).toContain('greet');
    }, 30_000);
  });

  describe('MCP config patching', () => {
    it('patched config contains only HTTP servers with rewritten URLs', async () => {
      const request = makeRequest({ studioSlug: 'live-mcp' });
      const containerName = buildContainerName(request);
      containersToCleanup.push(containerName);

      await orchestrator.spinUp(request);

      const { stdout } = await orchestrator.exec(containerName, ['cat', '/studio/.mcp.json']);
      const config = JSON.parse(stdout);

      // inkwell should be present with rewritten URL
      expect(config.mcpServers.inkwell).toBeDefined();
      expect(config.mcpServers.inkwell.url).toContain('host.docker.internal');

      // stdio server should be stripped
      expect(config.mcpServers.playwright).toBeUndefined();
    }, 30_000);
  });

  describe('LLM response', () => {
    const SKIP_LLM = !process.env.ANTHROPIC_API_KEY;

    it.skipIf(SKIP_LLM)(
      'gets a live Claude response inside the container',
      async () => {
        const request = makeRequest({ studioSlug: 'live-llm' });
        const containerName = buildContainerName(request);
        containersToCleanup.push(containerName);

        await orchestrator.spinUp(request);

        // Use claude CLI with --print (non-interactive, single-shot)
        // Ask a trivially answerable question to minimize cost
        const { stdout } = await orchestrator.exec(containerName, [
          'claude',
          '--print',
          '--model',
          'claude-haiku-4-5-20251001',
          'Reply with exactly the word SANDBOX and nothing else.',
        ]);

        expect(stdout.toUpperCase()).toContain('SANDBOX');
      },
      120_000
    );

    it.skipIf(SKIP_LLM)(
      'Claude can read workspace files via coding tools',
      async () => {
        const request = makeRequest({ studioSlug: 'live-read' });
        const containerName = buildContainerName(request);
        containersToCleanup.push(containerName);

        await orchestrator.spinUp(request);

        const { stdout } = await orchestrator.exec(containerName, [
          'claude',
          '--print',
          '--model',
          'claude-haiku-4-5-20251001',
          '--allowedTools',
          'Read',
          'Read the file src/hello.ts and tell me what function it exports. Reply with just the function name.',
        ]);

        expect(stdout.toLowerCase()).toContain('greet');
      },
      120_000
    );
  });

  describe('Inkwell MCP access', () => {
    const SKIP_INKWELL = !inkwellReachable() || !process.env.ANTHROPIC_API_KEY;

    it.skipIf(SKIP_INKWELL)(
      'container can reach Inkwell server via host.docker.internal',
      async () => {
        const request = makeRequest({ studioSlug: 'live-inkwell-reach' });
        const containerName = buildContainerName(request);
        containersToCleanup.push(containerName);

        await orchestrator.spinUp(request);

        // Verify HTTP connectivity to the Inkwell server
        const { stdout } = await orchestrator.exec(containerName, [
          'curl',
          '-sf',
          'http://host.docker.internal:3001/health',
        ]);

        // Health endpoint should return something (OK, JSON, etc.)
        expect(stdout.length).toBeGreaterThan(0);
      },
      30_000
    );
  });
});

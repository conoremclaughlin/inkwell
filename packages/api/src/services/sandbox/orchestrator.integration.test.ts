/**
 * Integration tests for SandboxOrchestrator.
 *
 * These tests spin up real Docker containers. They require:
 * - Docker daemon running
 * - The inkwell:studio-sandbox image built (`ink studio sandbox build`)
 *
 * Container reuse:
 *   A shared fixture container (ink-test-sandbox-integ) is spun up once
 *   and reused across capability tests. Set INK_PERSIST_TEST_CONTAINER=1
 *   to keep it alive after the run — saves ~20s on re-runs.
 *
 *   To tear it down manually: docker rm -f ink-test-sandbox-integ
 *
 * Run with: npx vitest run --config vitest.integration.config.ts src/services/sandbox/orchestrator.integration.test.ts
 */

import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { SandboxOrchestrator, buildContainerName, type SandboxSpinUpRequest } from './orchestrator';
import { createInkCodingTools, type InkToolDefinition } from '../../agent/tools/pi-coding-tools';
import { getProcessRegistry, resetProcessRegistry } from '../../agent/tools/bash-guard';

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

const SKIP = !dockerAvailable() || !imageExists('inkwell:studio-sandbox');
const PERSIST = process.env.INK_PERSIST_TEST_CONTAINER === '1';
const FIXTURE_NAME = 'ink-test-sandbox-integ';
// Stable path so persisted containers' mounts match across runs
const FIXTURE_DIR = join(homedir(), '.ink', 'test-fixtures', 'sandbox-integ');

describe.skipIf(SKIP)('SandboxOrchestrator (integration)', () => {
  let orchestrator: SandboxOrchestrator;
  let testDir: string;
  const ephemeralContainers: string[] = [];
  let fixtureWasPreExisting = false;

  beforeAll(async () => {
    orchestrator = new SandboxOrchestrator();

    // Use a stable dir for fixture containers, temp dir for ephemeral
    testDir = FIXTURE_DIR;
    mkdirSync(testDir, { recursive: true });
    // Refresh test files each run (idempotent)
    writeFileSync(join(testDir, 'hello.txt'), 'Integration test file\n');
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'index.ts'), 'console.log("hello");\n');
    // Clean up any output files from prior runs
    try {
      rmSync(join(testDir, 'fixture-output.txt'));
    } catch {}

    // Spin up or reuse the shared fixture container
    fixtureWasPreExisting = await orchestrator.isRunning(FIXTURE_NAME);
    if (!fixtureWasPreExisting) {
      const result = await orchestrator.spinUp({
        userId: 'test-user',
        agentId: 'test-agent',
        studioId: 'studio-integ-fixture',
        studioSlug: 'integ',
        worktreePath: testDir,
        repoRoot: testDir,
        containerName: FIXTURE_NAME,
      });
      expect(result.success).toBe(true);
    }
  });

  afterAll(async () => {
    // Always clean up ephemeral containers
    for (const name of ephemeralContainers) {
      await orchestrator.stop(name).catch(() => {});
    }
    // Only tear down fixture if not persisting and we created it this run
    if (!PERSIST && !fixtureWasPreExisting) {
      await orchestrator.stop(FIXTURE_NAME).catch(() => {});
    }
  });

  function makeRequest(overrides: Partial<SandboxSpinUpRequest> = {}): SandboxSpinUpRequest {
    return {
      userId: 'test-user',
      agentId: 'test-agent',
      studioId: `studio-${Date.now()}`,
      studioSlug: 'test',
      worktreePath: testDir,
      repoRoot: testDir,
      ...overrides,
    };
  }

  // ── Shared fixture tests (fast — reuse one container) ───────────────

  describe('shared fixture', () => {
    it('can read files at /studio', async () => {
      const { stdout } = await orchestrator.exec(FIXTURE_NAME, ['cat', '/studio/hello.txt']);
      expect(stdout.trim()).toBe('Integration test file');
    }, 10_000);

    it('has node and claude cli available', async () => {
      const { stdout: nodeVersion } = await orchestrator.exec(FIXTURE_NAME, ['node', '--version']);
      expect(nodeVersion.trim()).toMatch(/^v22\./);

      const { stdout: claudePath } = await orchestrator.exec(FIXTURE_NAME, ['which', 'claude']);
      expect(claudePath.trim()).toBeTruthy();
    }, 10_000);

    it('has correct workdir', async () => {
      const { stdout } = await orchestrator.exec(FIXTURE_NAME, ['pwd']);
      expect(stdout.trim()).toBe('/studio');
    }, 10_000);

    it('can write files visible on the host', async () => {
      await orchestrator.exec(FIXTURE_NAME, [
        'bash',
        '-c',
        'echo "from-fixture" > /studio/fixture-output.txt',
      ]);
      const { readFileSync } = await import('fs');
      const content = readFileSync(join(testDir, 'fixture-output.txt'), 'utf-8');
      expect(content.trim()).toBe('from-fixture');
    }, 10_000);
  });

  // ── Per-container lifecycle tests (each spins up its own) ───────────

  describe('container lifecycle', () => {
    it('spins up a container and verifies it is running', async () => {
      const request = makeRequest({ studioSlug: 'integ-spinup' });
      const containerName = buildContainerName(request);
      ephemeralContainers.push(containerName);

      const result = await orchestrator.spinUp(request);
      expect(result.success).toBe(true);
      expect(result.containerName).toBe(containerName);

      const running = await orchestrator.isRunning(containerName);
      expect(running).toBe(true);
    }, 30_000);

    it('returns alreadyRunning when container exists', async () => {
      const request = makeRequest({ studioSlug: 'integ-already' });
      const containerName = buildContainerName(request);
      ephemeralContainers.push(containerName);

      const first = await orchestrator.spinUp(request);
      expect(first.success).toBe(true);

      const second = await orchestrator.spinUp(request);
      expect(second.success).toBe(true);
      expect(second.alreadyRunning).toBe(true);
    }, 30_000);

    it('passes env vars into the container', async () => {
      const request = makeRequest({
        studioSlug: 'integ-env',
        taskGroupId: 'tg-test-123',
        taskGroupTitle: 'Test Group',
      });
      const containerName = buildContainerName(request);
      ephemeralContainers.push(containerName);

      await orchestrator.spinUp(request);

      const { stdout: agentId } = await orchestrator.exec(containerName, [
        'bash',
        '-c',
        'echo $AGENT_ID',
      ]);
      expect(agentId.trim()).toBe('test-agent');

      const { stdout: tgId } = await orchestrator.exec(containerName, [
        'bash',
        '-c',
        'echo $INK_TASK_GROUP_ID',
      ]);
      expect(tgId.trim()).toBe('tg-test-123');

      const { stdout: sandbox } = await orchestrator.exec(containerName, [
        'bash',
        '-c',
        'echo $INK_SANDBOX',
      ]);
      expect(sandbox.trim()).toBe('docker');
    }, 30_000);

    it('stops a running container', async () => {
      const request = makeRequest({ studioSlug: 'integ-stop' });
      const containerName = buildContainerName(request);

      await orchestrator.spinUp(request);
      expect(await orchestrator.isRunning(containerName)).toBe(true);

      const stopped = await orchestrator.stop(containerName);
      expect(stopped).toBe(true);
      expect(await orchestrator.isRunning(containerName)).toBe(false);
    }, 30_000);

    it('gets container status with labels', async () => {
      const request = makeRequest({
        studioSlug: 'integ-status',
        taskGroupId: 'tg-status-test',
      });
      const containerName = buildContainerName(request);
      ephemeralContainers.push(containerName);

      await orchestrator.spinUp(request);

      const status = await orchestrator.getStatus(containerName);
      expect(status.running).toBe(true);
      expect(status.labels?.['ink.sandbox']).toBe('true');
      expect(status.labels?.['ink.agent-id']).toBe('test-agent');
      expect(status.labels?.['ink.task-group-id']).toBe('tg-status-test');
    }, 30_000);

    it('lists active sandboxes', async () => {
      const request = makeRequest({ studioSlug: 'integ-list' });
      const containerName = buildContainerName(request);
      ephemeralContainers.push(containerName);

      await orchestrator.spinUp(request);

      const sandboxes = await orchestrator.listSandboxes();
      const found = sandboxes.find((s) => s.containerName === containerName);
      expect(found).toBeDefined();
      expect(found?.running).toBe(true);
    }, 30_000);

    it('container name includes task group context', async () => {
      const request = makeRequest({
        studioSlug: 'integ-naming',
        taskGroupId: 'tg-naming-test',
        taskGroupTitle: 'Auth Migration',
      });
      const containerName = buildContainerName(request);
      ephemeralContainers.push(containerName);

      expect(containerName).toContain('integ-naming');
      expect(containerName).toContain('auth-migration');

      await orchestrator.spinUp(request);
      const running = await orchestrator.isRunning(containerName);
      expect(running).toBe(true);
    }, 30_000);

    it('respects containerName override', async () => {
      const customName = 'ink-test-custom-name';
      const request = makeRequest({ containerName: customName });
      ephemeralContainers.push(customName);

      const result = await orchestrator.spinUp(request);
      expect(result.containerName).toBe(customName);
      expect(await orchestrator.isRunning(customName)).toBe(true);
    }, 30_000);
  });

  // ── Bash guard in container context ────────────────────────────────

  describe('bash guard (container context)', () => {
    let guardedTools: InkToolDefinition[];

    beforeAll(async () => {
      guardedTools = await createInkCodingTools({
        cwd: testDir,
        agentId: 'integ-guard-agent',
      });
    });

    afterEach(() => {
      resetProcessRegistry();
    });

    it('blocks fork bomb — container stays healthy', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: ':(){ :|:& };:' });
      expect(result).toContain('Blocked');
      expect(result).toContain('fork bomb');

      // Container is still alive — the fork bomb never executed
      const { stdout } = await orchestrator.exec(FIXTURE_NAME, ['echo', 'still-alive']);
      expect(stdout.trim()).toBe('still-alive');
    }, 10_000);

    it('blocks rm -rf / — workspace files intact', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'rm -rf /' });
      expect(result).toContain('Blocked');
      expect(result).toContain('recursive delete');

      // Workspace files still exist inside the container
      const { stdout } = await orchestrator.exec(FIXTURE_NAME, ['cat', '/studio/hello.txt']);
      expect(stdout).toContain('Integration test file');
    }, 10_000);

    it('blocks shutdown — container unaffected', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'shutdown -h now' });
      expect(result).toContain('Blocked');
      expect(result).toContain('shutdown');

      const { stdout } = await orchestrator.exec(FIXTURE_NAME, ['echo', 'not-shut-down']);
      expect(stdout.trim()).toBe('not-shut-down');
    }, 10_000);

    it('blocks kill of unregistered PIDs', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'kill 12345' });
      expect(result).toContain('Blocked');
      expect(result).toContain('not owned by this agent');
    }, 10_000);

    it('allows safe commands — result visible in container', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({
        command: 'echo "guard-allowed" > guard-test-output.txt',
      });
      // No error from guard
      expect(result).not.toContain('Blocked');

      // File created on host is visible inside the container
      const { stdout } = await orchestrator.exec(FIXTURE_NAME, [
        'cat',
        '/studio/guard-test-output.txt',
      ]);
      expect(stdout.trim()).toBe('guard-allowed');
    }, 10_000);

    it('allows kill of agent-owned PIDs', async () => {
      const registry = getProcessRegistry();
      registry.register('integ-guard-agent', 99999999, 'test-process');

      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      // Guard lets it through — actual kill fails (PID doesn't exist) but that's expected
      const result = await bash.execute({ command: 'kill 99999999' });
      expect(result).not.toContain('not owned by this agent');
    }, 10_000);

    it('cross-agent kill blocked — other agent PID protected', async () => {
      const registry = getProcessRegistry();
      registry.register('other-agent', 88888, 'other-process');

      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'kill 88888' });
      expect(result).toContain('Blocked');
      expect(result).toContain('88888');
    }, 10_000);
  });
});

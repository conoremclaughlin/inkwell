/**
 * Integration tests for SandboxOrchestrator.
 *
 * These tests spin up real Docker containers. They require:
 * - Docker daemon running
 * - The inkwell:studio-sandbox image built (`ink studio sandbox build`)
 *
 * Run with: npx vitest run --config vitest.integration.config.ts src/services/sandbox/orchestrator.integration.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
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

const SKIP = !dockerAvailable() || !imageExists('inkwell:studio-sandbox');

describe.skipIf(SKIP)('SandboxOrchestrator (integration)', () => {
  let orchestrator: SandboxOrchestrator;
  let testDir: string;
  const containersToCleanup: string[] = [];

  beforeAll(() => {
    orchestrator = new SandboxOrchestrator();
    testDir = mkdtempSync(join(tmpdir(), 'sandbox-integ-'));
    writeFileSync(join(testDir, 'hello.txt'), 'Integration test file\n');
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'index.ts'), 'console.log("hello");\n');
  });

  afterAll(async () => {
    for (const name of containersToCleanup) {
      await orchestrator.stop(name).catch(() => {});
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

  it('spins up a container and verifies it is running', async () => {
    const request = makeRequest({ studioSlug: 'integ-spinup' });
    const containerName = buildContainerName(request);
    containersToCleanup.push(containerName);

    const result = await orchestrator.spinUp(request);
    expect(result.success).toBe(true);
    expect(result.containerName).toBe(containerName);

    const running = await orchestrator.isRunning(containerName);
    expect(running).toBe(true);
  }, 30_000);

  it('returns alreadyRunning when container exists', async () => {
    const request = makeRequest({ studioSlug: 'integ-already' });
    const containerName = buildContainerName(request);
    containersToCleanup.push(containerName);

    const first = await orchestrator.spinUp(request);
    expect(first.success).toBe(true);

    const second = await orchestrator.spinUp(request);
    expect(second.success).toBe(true);
    expect(second.alreadyRunning).toBe(true);
  }, 30_000);

  it('mounts studio at /studio and can read files', async () => {
    const request = makeRequest({ studioSlug: 'integ-mount' });
    const containerName = buildContainerName(request);
    containersToCleanup.push(containerName);

    await orchestrator.spinUp(request);

    const { stdout } = await orchestrator.exec(containerName, ['cat', '/studio/hello.txt']);
    expect(stdout.trim()).toBe('Integration test file');
  }, 30_000);

  it('passes env vars into the container', async () => {
    const request = makeRequest({
      studioSlug: 'integ-env',
      taskGroupId: 'tg-test-123',
      taskGroupTitle: 'Test Group',
    });
    const containerName = buildContainerName(request);
    containersToCleanup.push(containerName);

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
    // Don't add to cleanup — we're stopping it ourselves

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
    containersToCleanup.push(containerName);

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
    containersToCleanup.push(containerName);

    await orchestrator.spinUp(request);

    const sandboxes = await orchestrator.listSandboxes();
    const found = sandboxes.find((s) => s.containerName === containerName);
    expect(found).toBeDefined();
    expect(found?.running).toBe(true);
  }, 30_000);

  it('container has node and claude cli available', async () => {
    const request = makeRequest({ studioSlug: 'integ-tools' });
    const containerName = buildContainerName(request);
    containersToCleanup.push(containerName);

    await orchestrator.spinUp(request);

    const { stdout: nodeVersion } = await orchestrator.exec(containerName, ['node', '--version']);
    expect(nodeVersion.trim()).toMatch(/^v22\./);

    const { stdout: claudePath } = await orchestrator.exec(containerName, ['which', 'claude']);
    expect(claudePath.trim()).toBeTruthy();
  }, 30_000);

  it('container name includes task group context', async () => {
    const request = makeRequest({
      studioSlug: 'integ-naming',
      taskGroupId: 'tg-naming-test',
      taskGroupTitle: 'Auth Migration',
    });
    const containerName = buildContainerName(request);
    containersToCleanup.push(containerName);

    expect(containerName).toContain('integ-naming');
    expect(containerName).toContain('auth-migration');

    await orchestrator.spinUp(request);
    const running = await orchestrator.isRunning(containerName);
    expect(running).toBe(true);
  }, 30_000);
});

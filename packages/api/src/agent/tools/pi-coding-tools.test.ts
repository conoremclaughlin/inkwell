import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { createInkCodingTools, type InkToolDefinition } from './pi-coding-tools';
import { resetProcessRegistry, getProcessRegistry } from './bash-guard';

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Pi Coding Tools Adapter', () => {
  let testDir: string;
  let tools: InkToolDefinition[];

  beforeAll(async () => {
    testDir = mkdtempSync(path.join(tmpdir(), 'pi-tools-test-'));
    writeFileSync(path.join(testDir, 'hello.txt'), 'Hello, world!\n');
    mkdirSync(path.join(testDir, 'subdir'));
    writeFileSync(path.join(testDir, 'subdir', 'nested.txt'), 'nested content\n');

    tools = await createInkCodingTools({ cwd: testDir });
  });

  it('loads all 7 coding tools', () => {
    const names = tools.map((t) => t.schema.name);
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names).toContain('grep');
    expect(names).toContain('find');
    expect(names).toContain('ls');
    expect(names.length).toBe(7);
  });

  it('generates valid Anthropic tool schemas', () => {
    for (const tool of tools) {
      expect(tool.schema.name).toBeTruthy();
      expect(tool.schema.input_schema).toBeDefined();
      expect(tool.schema.input_schema.type).toBe('object');
    }
  });

  describe('read tool', () => {
    it('reads files within workspace', async () => {
      const readTool = tools.find((t) => t.schema.name === 'read')!;
      const result = await readTool.execute({ path: 'hello.txt' });
      expect(result).toContain('Hello, world!');
    });

    it('reads nested files', async () => {
      const readTool = tools.find((t) => t.schema.name === 'read')!;
      const result = await readTool.execute({ path: 'subdir/nested.txt' });
      expect(result).toContain('nested content');
    });
  });

  describe('write tool', () => {
    it('writes a file within workspace', async () => {
      const writeTool = tools.find((t) => t.schema.name === 'write')!;
      await writeTool.execute({ path: 'output.txt', content: 'written by test\n' });
      const content = readFileSync(path.join(testDir, 'output.txt'), 'utf-8');
      expect(content).toBe('written by test\n');
    });
  });

  describe('bash tool', () => {
    it('runs safe commands', async () => {
      const bashTool = tools.find((t) => t.schema.name === 'bash')!;
      const result = await bashTool.execute({ command: 'echo hello' });
      expect(result).toContain('hello');
    });

    it('can list files', async () => {
      const bashTool = tools.find((t) => t.schema.name === 'bash')!;
      const result = await bashTool.execute({ command: 'ls' });
      expect(result).toContain('hello.txt');
      expect(result).toContain('subdir');
    });

    it('can read files with cat', async () => {
      const bashTool = tools.find((t) => t.schema.name === 'bash')!;
      const result = await bashTool.execute({ command: 'cat hello.txt' });
      expect(result).toContain('Hello, world!');
    });

    it('reports pwd as the workspace directory', async () => {
      const bashTool = tools.find((t) => t.schema.name === 'bash')!;
      const result = await bashTool.execute({ command: 'pwd' });
      expect(result).toContain(testDir);
    });
  });

  describe('grep tool', () => {
    it('finds text in files', async () => {
      const grepTool = tools.find((t) => t.schema.name === 'grep')!;
      const result = await grepTool.execute({ pattern: 'Hello', path: '.' });
      expect(result).toContain('hello.txt');
    });
  });

  describe('find tool', () => {
    it('finds files by name', async () => {
      const findTool = tools.find((t) => t.schema.name === 'find')!;
      const result = await findTool.execute({ pattern: '*.txt', path: '.' });
      expect(result).toContain('hello.txt');
      expect(result).toContain('nested.txt');
    });
  });

  describe('ls tool', () => {
    it('lists directory contents', async () => {
      const lsTool = tools.find((t) => t.schema.name === 'ls')!;
      const result = await lsTool.execute({ path: '.' });
      expect(result).toContain('hello.txt');
      expect(result).toContain('subdir');
    });
  });

  describe('workspace root enforcement', () => {
    it('blocks absolute path escape', async () => {
      const readTool = tools.find((t) => t.schema.name === 'read')!;
      const result = await readTool.execute({ path: '/etc/hostname' });
      expect(result).toContain('Access denied');
      expect(result).toContain('outside workspace root');
    });

    it('blocks relative path traversal', async () => {
      const readTool = tools.find((t) => t.schema.name === 'read')!;
      const result = await readTool.execute({ path: '../../etc/hostname' });
      expect(result).toContain('Access denied');
    });

    it('can be disabled', async () => {
      const unenforced = await createInkCodingTools({
        cwd: testDir,
        enforceWorkspaceRoot: false,
        include: ['read'],
      });
      const readTool = unenforced[0];
      const result = await readTool.execute({ path: '/tmp' });
      // Won't get "Access denied" — might get a different error (reading a dir), but not workspace enforcement
      expect(result).not.toContain('Access denied');
    });
  });

  describe('include/exclude filtering', () => {
    it('respects include filter', async () => {
      const filtered = await createInkCodingTools({
        cwd: testDir,
        include: ['read', 'ls'],
      });
      const names = filtered.map((t) => t.schema.name);
      expect(names).toEqual(['read', 'ls']);
    });

    it('respects exclude filter', async () => {
      const filtered = await createInkCodingTools({
        cwd: testDir,
        exclude: ['bash'],
      });
      const names = filtered.map((t) => t.schema.name);
      expect(names).not.toContain('bash');
      expect(names.length).toBe(6);
    });
  });

  describe('bash guard integration', () => {
    let guardedTools: InkToolDefinition[];

    beforeAll(async () => {
      guardedTools = await createInkCodingTools({
        cwd: testDir,
        agentId: 'test-agent',
      });
    });

    afterEach(() => {
      resetProcessRegistry();
    });

    it('blocks fork bombs before execution', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: ':(){ :|:& };:' });
      expect(result).toContain('Error');
      expect(result).toContain('fork bomb');
    });

    it('blocks rm -rf / before execution', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'rm -rf /' });
      expect(result).toContain('Error');
      expect(result).toContain('recursive delete');
    });

    it('blocks shutdown before execution', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'shutdown -h now' });
      expect(result).toContain('Error');
      expect(result).toContain('shutdown');
    });

    it('blocks kill targeting unregistered PIDs', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'kill 99999' });
      expect(result).toContain('Error');
      expect(result).toContain('not owned by this agent');
    });

    it('allows kill targeting own registered PIDs', async () => {
      const registry = getProcessRegistry();
      registry.register('test-agent', 99999999, 'sleep 100');

      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      // The kill will execute but fail (PID doesn't exist) — that's fine,
      // the point is the guard lets it through
      const result = await bash.execute({ command: 'kill 99999999' });
      expect(result).not.toContain('not owned by this agent');
    });

    it('allows safe commands with guard enabled', async () => {
      const bash = guardedTools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'echo guarded-hello' });
      expect(result).toContain('guarded-hello');
    });

    it('does not guard when agentId is not set', async () => {
      // The original tools (no agentId) should work normally
      const bash = tools.find((t) => t.schema.name === 'bash')!;
      const result = await bash.execute({ command: 'echo unguarded' });
      expect(result).toContain('unguarded');
    });

    it('guard does not interfere with non-bash tools', async () => {
      const readTool = guardedTools.find((t) => t.schema.name === 'read')!;
      const result = await readTool.execute({ path: 'hello.txt' });
      expect(result).toContain('Hello, world!');
    });
  });
});

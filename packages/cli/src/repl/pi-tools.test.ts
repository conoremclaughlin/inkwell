import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { isPiTool, getPiToolNames, callPiTool, initPiTools } from './pi-tools.js';
import { PathContainmentError } from '@inklabs/shared';
import { executeToolCalls, type ToolCallExecutorDeps } from './tool-call-executor.js';

// ─── Unit Tests ──────────────────────────────────────────────────────

describe('pi-tools: unit', () => {
  describe('isPiTool', () => {
    it('identifies all 7 coding tools', () => {
      for (const name of ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']) {
        expect(isPiTool(name)).toBe(true);
      }
    });

    it('rejects Inkwell tools', () => {
      for (const name of ['recall', 'remember', 'send_response', 'get_inbox', 'bootstrap']) {
        expect(isPiTool(name)).toBe(false);
      }
    });

    it('rejects namespaced tool names', () => {
      expect(isPiTool('mcp__inkwell__recall')).toBe(false);
      expect(isPiTool('mcp__inkwell__read')).toBe(false);
    });

    it('rejects client-local tools', () => {
      expect(isPiTool('list_context')).toBe(false);
      expect(isPiTool('evict_context')).toBe(false);
      expect(isPiTool('signal_status')).toBe(false);
    });
  });

  describe('getPiToolNames', () => {
    it('returns all 7 tool names', () => {
      const names = getPiToolNames();
      expect(names).toHaveLength(7);
      expect(new Set(names)).toEqual(
        new Set(['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'])
      );
    });
  });
});

// ─── Live Tests (actual Pi tool execution) ───────────────────────────

describe('pi-tools: live', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pi-tools-test-'));
    // Set up test fixtures
    await writeFile(path.join(tmpDir, 'hello.txt'), 'Hello, world!\nLine two\nLine three\n');
    await writeFile(path.join(tmpDir, 'code.ts'), 'const x = 1;\nconst y = 2;\nexport { x, y };\n');
    await mkdir(path.join(tmpDir, 'subdir'));
    await writeFile(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('initPiTools', () => {
    it('creates all 7 tools', async () => {
      const tools = await initPiTools(tmpDir);
      expect(tools.size).toBe(7);
      for (const name of ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']) {
        expect(tools.has(name)).toBe(true);
      }
    });

    it('caches tools for same cwd', async () => {
      const tools1 = await initPiTools(tmpDir);
      const tools2 = await initPiTools(tmpDir);
      expect(tools1).toBe(tools2);
    });
  });

  describe('read', () => {
    it('reads a file', async () => {
      const result = await callPiTool('read', { path: 'hello.txt' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('Hello, world!');
      expect(result.text).toContain('Line two');
    });

    it('reads with offset and limit', async () => {
      // Pi offset is 1-based line number, limit is line count
      const result = await callPiTool('read', { path: 'hello.txt', offset: 2, limit: 1 }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('Line two');
    });

    it('throws ENOENT for missing file within workspace', async () => {
      await expect(callPiTool('read', { path: 'nonexistent.txt' }, tmpDir)).rejects.toThrow(
        'ENOENT'
      );
    });
  });

  describe('write', () => {
    it('creates a new file', async () => {
      await callPiTool('write', { path: 'new-file.txt', content: 'fresh content' }, tmpDir);
      const written = await readFile(path.join(tmpDir, 'new-file.txt'), 'utf-8');
      expect(written).toBe('fresh content');
    });

    it('overwrites an existing file', async () => {
      await callPiTool('write', { path: 'hello.txt', content: 'overwritten' }, tmpDir);
      const written = await readFile(path.join(tmpDir, 'hello.txt'), 'utf-8');
      expect(written).toBe('overwritten');
    });

    it('creates intermediate directories', async () => {
      await callPiTool('write', { path: 'deep/nested/dir/file.txt', content: 'deep' }, tmpDir);
      const written = await readFile(
        path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt'),
        'utf-8'
      );
      expect(written).toBe('deep');
    });
  });

  describe('edit', () => {
    it('replaces text in a file', async () => {
      // Pi edit takes { path, edits: [{ oldText, newText }] }
      const result = await callPiTool(
        'edit',
        {
          path: 'code.ts',
          edits: [{ oldText: 'const x = 1;', newText: 'const x = 42;' }],
        },
        tmpDir
      );
      expect(result.success).toBe(true);
      const edited = await readFile(path.join(tmpDir, 'code.ts'), 'utf-8');
      expect(edited).toContain('const x = 42;');
      expect(edited).toContain('const y = 2;');
    });
  });

  describe('bash', () => {
    it('executes a shell command', async () => {
      const result = await callPiTool('bash', { command: 'echo "hello from bash"' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('hello from bash');
    });

    it('returns command output', async () => {
      const result = await callPiTool('bash', { command: 'ls' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('hello.txt');
      expect(result.text).toContain('code.ts');
    });
  });

  describe('ls', () => {
    it('lists directory contents', async () => {
      const result = await callPiTool('ls', { path: '.' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('hello.txt');
      expect(result.text).toContain('subdir');
    });
  });

  describe('grep', () => {
    it('searches file contents', async () => {
      const result = await callPiTool('grep', { pattern: 'const', path: '.' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('const x = 1');
    });
  });

  describe('find', () => {
    it('finds files by pattern', async () => {
      const result = await callPiTool('find', { pattern: '*.txt', path: '.' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('hello.txt');
    });
  });

  describe('callPiTool error handling', () => {
    it('throws on unknown tool name', async () => {
      await expect(callPiTool('nonexistent', {}, tmpDir)).rejects.toThrow(
        'Pi tool "nonexistent" not found'
      );
    });
  });

  describe('result format', () => {
    it('returns PcpToolCallResult shape with content array', async () => {
      const result = await callPiTool('read', { path: 'hello.txt' }, tmpDir);
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('success', true);
      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.length).toBeGreaterThan(0);
      expect(content[0].type).toBe('text');
    });
  });

  describe('path containment', () => {
    it('blocks read with ../ traversal', async () => {
      const outsideFile = path.join(tmpDir, '..', 'outside-read.txt');
      await writeFile(outsideFile, 'should not be readable');
      try {
        await expect(callPiTool('read', { path: '../outside-read.txt' }, tmpDir)).rejects.toThrow(
          PathContainmentError
        );
      } finally {
        await rm(outsideFile, { force: true });
      }
    });

    it('blocks write with ../ traversal', async () => {
      await expect(
        callPiTool('write', { path: '../escape.txt', content: 'escaped!' }, tmpDir)
      ).rejects.toThrow(PathContainmentError);
    });

    it('blocks edit with ../ traversal', async () => {
      await expect(callPiTool('edit', { path: '../hello.txt', edits: [] }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    });

    it('blocks absolute path outside workspace', async () => {
      await expect(callPiTool('read', { path: '/etc/passwd' }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    });

    it('blocks ls with ../ traversal', async () => {
      await expect(callPiTool('ls', { path: '..' }, tmpDir)).rejects.toThrow(PathContainmentError);
    });

    it('blocks grep with ../ traversal', async () => {
      await expect(callPiTool('grep', { pattern: 'secret', path: '..' }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    });

    it('blocks find with ../ traversal', async () => {
      await expect(callPiTool('find', { pattern: '*', path: '..' }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    });

    it('allows paths within workspace', async () => {
      const result = await callPiTool('read', { path: 'subdir/nested.txt' }, tmpDir);
      expect(result.success).toBe(true);
      expect(result.text).toContain('nested content');
    });

    it('allows . as path', async () => {
      const result = await callPiTool('ls', { path: '.' }, tmpDir);
      expect(result.success).toBe(true);
    });

    it('blocks symlink escaping workspace', async () => {
      const { symlink } = await import('fs/promises');
      const linkPath = path.join(tmpDir, 'escape-link');
      await symlink('/tmp', linkPath);
      await expect(callPiTool('read', { path: 'escape-link/some-file' }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    });
  });
});

// ─── Integration Tests (through executeToolCalls pipeline) ───────────

describe('pi-tools: integration with executeToolCalls', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pi-tools-int-'));
    await writeFile(path.join(tmpDir, 'target.txt'), 'original content\n');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<ToolCallExecutorDeps> = {}): ToolCallExecutorDeps {
    return {
      policy: {
        canCallPcpTool: vi.fn().mockReturnValue({ allowed: true, reason: '' }),
      } as unknown as ToolCallExecutorDeps['policy'],
      callTool: (tool, args) => {
        // Pi tools are routed in-process; non-Pi tools go to mock PCP server
        if (isPiTool(tool)) {
          return callPiTool(tool, args, tmpDir);
        }
        return Promise.resolve({ success: true, mocked: true });
      },
      sessionId: 'test-session',
      promptForApproval: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it('routes Pi tools through the pipeline', async () => {
    const deps = makeDeps();
    const results = await executeToolCalls(
      [{ tool: 'read', args: { path: 'target.txt' }, raw: '' }],
      deps
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('executed');
    const result = results[0].result as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.text).toContain('original content');
  });

  it('routes Inkwell tools to mock PCP server', async () => {
    const deps = makeDeps();
    const results = await executeToolCalls(
      [{ tool: 'recall', args: { query: 'test' }, raw: '' }],
      deps
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('executed');
    const result = results[0].result as Record<string, unknown>;
    expect(result.mocked).toBe(true);
  });

  it('mixes Pi and Inkwell tools in same batch', async () => {
    const deps = makeDeps();
    const results = await executeToolCalls(
      [
        { tool: 'read', args: { path: 'target.txt' }, raw: '' },
        { tool: 'recall', args: { query: 'something' }, raw: '' },
        { tool: 'ls', args: { path: '.' }, raw: '' },
      ],
      deps
    );

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('executed');
    expect((results[0].result as Record<string, unknown>).text).toContain('original content');
    expect(results[1].status).toBe('executed');
    expect((results[1].result as Record<string, unknown>).mocked).toBe(true);
    expect(results[2].status).toBe('executed');
    expect((results[2].result as Record<string, unknown>).text).toContain('target.txt');
  });

  it('respects tool policy for Pi tools', async () => {
    const deps = makeDeps({
      policy: {
        canCallPcpTool: vi.fn().mockReturnValue({
          allowed: false,
          promptable: false,
          reason: 'bash is denied',
        }),
      } as unknown as ToolCallExecutorDeps['policy'],
    });

    const results = await executeToolCalls(
      [{ tool: 'bash', args: { command: 'echo hi' }, raw: '' }],
      deps
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('blocked');
    expect(results[0].reason).toBe('bash is denied');
  });

  it('supports approval flow for Pi tools', async () => {
    const deps = makeDeps({
      policy: {
        canCallPcpTool: vi
          .fn()
          .mockReturnValueOnce({ allowed: false, promptable: true, reason: 'needs approval' })
          .mockReturnValueOnce({ allowed: true, reason: '' }),
      } as unknown as ToolCallExecutorDeps['policy'],
      promptForApproval: vi.fn().mockResolvedValue(true),
    });

    const results = await executeToolCalls(
      [{ tool: 'read', args: { path: 'target.txt' }, raw: '' }],
      deps
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('approved');
    expect(deps.promptForApproval).toHaveBeenCalledWith('read', 'needs approval');
  });

  it('handles Pi tool path containment errors gracefully', async () => {
    const deps = makeDeps();
    const results = await executeToolCalls(
      [{ tool: 'read', args: { path: '/absolute/nonexistent/path/that/breaks' }, raw: '' }],
      deps
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('Path containment violation');
  });

  it('handles Pi tool ENOENT errors gracefully', async () => {
    const deps = makeDeps();
    const results = await executeToolCalls(
      [{ tool: 'read', args: { path: 'does-not-exist.txt' }, raw: '' }],
      deps
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('ENOENT');
  });

  it('full roundtrip: write then read', async () => {
    const deps = makeDeps();

    // Write a file
    const writeResults = await executeToolCalls(
      [{ tool: 'write', args: { path: 'roundtrip.txt', content: 'roundtrip data' }, raw: '' }],
      deps
    );
    expect(writeResults[0].status).toBe('executed');

    // Read it back
    const readResults = await executeToolCalls(
      [{ tool: 'read', args: { path: 'roundtrip.txt' }, raw: '' }],
      deps
    );
    expect(readResults[0].status).toBe('executed');
    expect((readResults[0].result as Record<string, unknown>).text).toContain('roundtrip data');
  });
});

// ─── PDF Document Adapter ──────────────────────────────────────────

describe('pi-tools: PDF read adapter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pi-pdf-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeMinimalPdf(text: string): Buffer {
    // Minimal valid PDF with one page containing the given text.
    // This is a bare-minimum PDF 1.4 structure that pdf-parse can extract.
    const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
    const streamBytes = Buffer.from(stream);
    const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj`,
      `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream\nendobj`,
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
    ];

    let body = '';
    const offsets: number[] = [];
    const header = '%PDF-1.4\n';
    let pos = header.length;
    for (const obj of objects) {
      offsets.push(pos);
      body += obj + '\n';
      pos += Buffer.byteLength(obj + '\n');
    }

    const xrefStart = pos;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    return Buffer.from(header + body + xref);
  }

  it('extracts text from a PDF file via the read adapter', async () => {
    const pdfPath = path.join(tmpDir, 'test.pdf');
    await writeFile(pdfPath, makeMinimalPdf('Hello from PDF'));

    const result = await callPiTool('read', { path: 'test.pdf' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.text).toContain('Hello from PDF');
    expect(result.text).toContain('[PDF:');
    expect(result.text).toContain('1 page');
  });

  it('throws for non-existent PDF (falls through to Pi read)', async () => {
    // Non-existent .pdf: tryReadDocument returns null (existsSync fails),
    // so it falls through to the Pi read tool which throws ENOENT.
    await expect(callPiTool('read', { path: 'missing.pdf' }, tmpDir)).rejects.toThrow('ENOENT');
  });

  it('does not intercept non-PDF files', async () => {
    const txtPath = path.join(tmpDir, 'notes.txt');
    await writeFile(txtPath, 'plain text content');

    const result = await callPiTool('read', { path: 'notes.txt' }, tmpDir);
    expect(result.success).toBe(true);
    expect(result.text).toContain('plain text content');
    expect(result.text).not.toContain('[PDF:');
  });

  it('blocks PDF read with ../ traversal (path containment)', async () => {
    const outsidePdf = path.join(tmpDir, '..', 'escape.pdf');
    await writeFile(outsidePdf, makeMinimalPdf('escaped content'));
    try {
      await expect(callPiTool('read', { path: '../escape.pdf' }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    } finally {
      await rm(outsidePdf, { force: true });
    }
  });

  it('blocks PDF read with absolute path outside workspace', async () => {
    await expect(callPiTool('read', { path: '/tmp/secret.pdf' }, tmpDir)).rejects.toThrow(
      PathContainmentError
    );
  });

  it('blocks PDF read via symlink escaping workspace', async () => {
    const { symlink } = await import('fs/promises');
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'pi-pdf-outside-'));
    await writeFile(path.join(outsideDir, 'secret.pdf'), makeMinimalPdf('secret'));
    const linkPath = path.join(tmpDir, 'linked-dir');
    await symlink(outsideDir, linkPath);
    try {
      await expect(callPiTool('read', { path: 'linked-dir/secret.pdf' }, tmpDir)).rejects.toThrow(
        PathContainmentError
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

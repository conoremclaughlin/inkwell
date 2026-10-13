import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'vm';

const state = vi.hoisted(() => ({
  resolve: vi.fn(() => '/synthetic/dependencies/pdf-parse.cjs'),
  createRequire: vi.fn(),
  execFile: vi.fn(),
  bytes: undefined as Buffer | undefined,
  output: JSON.stringify({ text: 'synthetic text', total: 45 }),
  error: null as Error | null,
}));
vi.mock('module', () => ({ createRequire: state.createRequire }));
vi.mock('child_process', () => ({ execFile: state.execFile }));

import {
  extractPdfText,
  MAX_DOCUMENT_TEXT_CHARS,
  PDF_EXTRACT_TIMEOUT_MS,
} from './pdf-extractor.js';
import { pdfExtractorModulePath } from './pdf-extractor-path.cjs';

beforeEach(() => {
  state.resolve.mockReset().mockReturnValue('/synthetic/dependencies/pdf-parse.cjs');
  state.createRequire.mockReset().mockReturnValue({ resolve: state.resolve });
  state.execFile.mockReset().mockImplementation((_binary, _args, _opts, callback) => ({
    stdin: Object.assign(new EventEmitter(), {
      end(bytes: Buffer) {
        state.bytes = bytes;
        queueMicrotask(() => callback(state.error, state.output, ''));
      },
    }),
  }));
  state.bytes = undefined;
  state.output = JSON.stringify({ text: 'synthetic text', total: 45 });
  state.error = null;
});

describe('bounded async PDF child, fake processes only', () => {
  it('resolves only its package dependency and passes bounded bytes to an empty-env child', async () => {
    const bytes = Buffer.from('%PDF-synthetic');
    expect(await extractPdfText(bytes, 30)).toEqual({
      text: 'synthetic text',
      pages: 30,
      total: 45,
    });
    expect(state.createRequire).toHaveBeenCalledWith(pdfExtractorModulePath);
    expect(state.resolve).toHaveBeenCalledWith('pdf-parse');
    const [binary, args, options] = state.execFile.mock.calls[0]!;
    expect(binary).toBe(process.execPath);
    expect(args.slice(2)).toEqual([
      '/synthetic/dependencies/pdf-parse.cjs',
      '30',
      String(MAX_DOCUMENT_TEXT_CHARS + 1),
    ]);
    expect(options).toMatchObject({
      env: {},
      timeout: PDF_EXTRACT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 6 * (MAX_DOCUMENT_TEXT_CHARS + 1) + 64 * 1024,
    });
    expect(options.cwd).toBe(
      pdfExtractorModulePath.slice(0, pdfExtractorModulePath.lastIndexOf('/'))
    );
    expect(state.bytes).toBe(bytes);
  });

  it('does not block another request while a parser is still pending', async () => {
    const complete: Array<() => void> = [];
    state.execFile.mockImplementation((_binary, _args, _opts, callback) => ({
      stdin: Object.assign(new EventEmitter(), {
        end() {
          complete.push(() => callback(null, state.output, ''));
        },
      }),
    }));
    let settled = false;
    const first = extractPdfText(Buffer.from('one'), 1).then((result) => {
      settled = true;
      return result;
    });
    const second = extractPdfText(Buffer.from('two'), 2);
    expect(complete).toHaveLength(2);
    complete[1]!();
    expect((await second)?.pages).toBe(2);
    expect(settled).toBe(false);
    complete[0]!();
    expect((await first)?.pages).toBe(1);
  });

  it.each([0, -1, NaN, Infinity])(
    'spawns nothing without a finite positive remaining budget (%s)',
    async (budget) => {
      expect(await extractPdfText(Buffer.from('x'), 1, budget)).toBeNull();
      expect(state.execFile).not.toHaveBeenCalled();
    }
  );

  it('uses only the remaining turn deadline, rounded up from fractional milliseconds', async () => {
    await extractPdfText(Buffer.from('x'), 1, 300.1);
    expect(state.execFile.mock.calls[0]![2]).toMatchObject({ timeout: 301, killSignal: 'SIGKILL' });
  });

  it.each(['timeout', 'maxBuffer exceeded', 'parser failure'])(
    'rejects a failed parser (%s)',
    async (reason) => {
      state.error = new Error(reason);
      expect(await extractPdfText(Buffer.from('x'), 1)).toBeNull();
    }
  );

  it.each(['not JSON', '{}', '{"text": 1, "total": 1}'])(
    'rejects malformed parser output (%s)',
    async (output) => {
      state.output = output;
      expect(await extractPdfText(Buffer.from('x'), 1)).toBeNull();
    }
  );

  it('fails closed when the dependency is absent', async () => {
    state.resolve.mockImplementation(() => {
      throw new Error('synthetic missing package');
    });
    expect(await extractPdfText(Buffer.from('x'), 1)).toBeNull();
    expect(state.execFile).not.toHaveBeenCalled();
  });

  it('ignores an early-close stdin error and settles from the child failure', async () => {
    state.execFile.mockImplementation((_binary, _args, _opts, callback) => ({
      stdin: Object.assign(new EventEmitter(), {
        end() {
          this.emit('error', new Error('synthetic EPIPE'));
          queueMicrotask(() => callback(new Error('parser exited'), '', ''));
        },
      }),
    }));
    expect(await extractPdfText(Buffer.from('x'), 1)).toBeNull();
  });

  // Exercise the exact script handed to execFile with a fake process and
  // parser, not a child or a real PDF dependency. The reviewed real-parser
  // fixture cases are retained separately in claude.test.ts.
  it.each([false, true])('keeps page markers only for a PDF with text (%s)', async (hasText) => {
    await extractPdfText(Buffer.from('x'), 30);
    const script = state.execFile.mock.calls[0]![1][1] as string;
    const stdin = new EventEmitter();
    const output: string[] = [];
    const destroy = vi.fn(async () => undefined);
    const parseOptions: unknown[] = [];
    runInNewContext(script, {
      Buffer,
      Uint8Array,
      require: (name: string) => {
        expect(name).toBe('/synthetic/parser');
        return {
          PDFParse: class {
            constructor(options: unknown) {
              parseOptions.push(options);
            }
            async getText(options: unknown) {
              expect(options).toEqual({ first: 30 });
              return {
                text: 'words -- 1 of 1 --',
                pages: [{ text: hasText ? 'words' : '  ' }],
                total: 1,
              };
            }
            destroy = destroy;
          },
        };
      },
      process: {
        argv: ['node', '/synthetic/parser', '30', '100001'],
        stdin,
        stdout: { write: (text: string) => output.push(text) },
      },
    });
    stdin.emit('data', Buffer.from('synthetic bytes'));
    stdin.emit('end');
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
    expect(parseOptions[0]).toMatchObject({ isEvalSupported: false });
    expect(JSON.parse(output[0]!)).toEqual({ text: hasText ? 'words -- 1 of 1 --' : '', total: 1 });
  });
});

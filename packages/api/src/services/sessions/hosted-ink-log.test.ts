import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ContextLedger,
  hydrateLedgerFromEvents,
  hydrateLedgerFromEventStream,
} from '@inklabs/shared/runtime';
import { openHostedInkLog, hostedCloneLog } from './hosted-ink-log';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function read(log: Awaited<ReturnType<typeof openHostedInkLog>>) {
  const entries: Record<string, unknown>[] = [];
  for await (const entry of await log.read()) entries.push(entry);
  return entries;
}
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ink-hosted-log-')));
  roots.push(cwd);
  const dir = join(cwd, '.ink', 'runtime', 'repl');
  await mkdir(dir, { recursive: true });
  return { cwd, dir };
}
describe('hosted JSONL continuity', () => {
  it('reopens the CLI parent, never a newer clone; flush precedes live projection', async () => {
    const { cwd, dir } = await fixture();
    const parent = join(dir, 'session-100.jsonl');
    await writeFile(parent, '{"eid":7,"type":"assistant","text":"prior"}\n{"torn":');
    await utimes(parent, 1, 1);
    await writeFile(join(dir, 'session-100.clone-1.jsonl'), '{"eid":999,"type":"assistant"}\n');
    const project = vi.fn();
    const register = vi.fn();
    const log = await openHostedInkLog({ cwd, sessionId: 'session', project, register });
    expect(log.path).toBe(parent);
    expect(await read(log)).toEqual([{ eid: 7, type: 'assistant', text: 'prior' }]);
    log.seed(7);
    expect(log.append({ type: 'assistant', text: 'new' })).toBe(8);
    expect(project).not.toHaveBeenCalled();
    await log.flush();
    expect(project).toHaveBeenCalledWith(expect.objectContaining({ eid: 8, text: 'new' }));
    expect((await read(log)).map((x) => x.eid)).toEqual([7, 8]);
    expect(register).toHaveBeenCalledWith(parent);
    const clone = hostedCloneLog(parent, parent.replace('.jsonl', '.clone-2.jsonl'));
    clone.append({ type: 'clone_start' });
    await clone.flush();
    expect(await readFile(clone.path, 'utf8')).toContain('clone_start');
    expect(project).toHaveBeenCalledTimes(1);
  });
  it('streams chunked UTF-8 and refuses oversized individual entries', async () => {
    const { cwd, dir } = await fixture();
    const path = join(dir, 'session-100.jsonl');
    const text = 'あ'.repeat(25000);
    await writeFile(path, JSON.stringify({ type: 'assistant', eid: 4, text }) + '\n');
    const log = await openHostedInkLog({
      cwd,
      sessionId: 'session',
      project: () => {},
      register: () => {},
    });
    expect((await read(log))[0].text).toBe(text);
    await writeFile(
      path,
      JSON.stringify({ type: 'assistant', text: 'x'.repeat(1024 * 1024 + 1) }) + '\n'
    );
    await expect(read(log)).rejects.toThrow('entry exceeds');
  });
  it('restores an append-only ledger over 8 MiB through compaction with CLI-equivalent state', async () => {
    const { cwd, dir } = await fixture();
    const events: Record<string, unknown>[] = [
      { type: 'inbox', rendered: 'old mail', messageId: 'mail-before-compaction', eid: 1 },
      { type: 'hook_injection', content: 'recalled', memoryId: 'old-memory', eid: 2 },
      ...Array.from({ length: 260 }, (_, i) => ({
        type: 'assistant',
        content: 'x'.repeat(32768),
        eid: i + 3,
      })),
      {
        type: 'compaction',
        summary: 'compact summary',
        keptEntries: [{ role: 'user', content: 'keep me', eid: 262 }],
        eid: 263,
      },
      { type: 'assistant', content: 'after', eid: 264 },
      { type: 'provider_sample', backend: 'claude', contextTokens: 100, at: 'fixture', eid: 265 },
      { type: 'backend_session_invalidated', eid: 266 },
    ];
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(Buffer.byteLength(text)).toBeGreaterThan(8 * 1024 * 1024);
    await writeFile(join(dir, 'session-100.jsonl'), text);
    const log = await openHostedInkLog({
      cwd,
      sessionId: 'session',
      project: () => {},
      register: () => {},
    });
    const cli = new ContextLedger(),
      hosted = new ContextLedger();
    const expected = hydrateLedgerFromEvents(cli, events);
    const actual = await hydrateLedgerFromEventStream(hosted, await log.read());
    expect(actual).toEqual(expected);
    expect(actual.maxEid).toBe(266);
    expect(actual.seenInboxIds).toEqual(['mail-before-compaction']);
    expect(actual.recoveredMemoryIds).toEqual(['old-memory']);
    expect(actual.providerSample).toBeUndefined();
    expect(hosted.listEntries().map((e) => [e.role, e.content, e.eid])).toEqual(
      cli.listEntries().map((e) => [e.role, e.content, e.eid])
    );
    expect(hosted.listEntries().map((e) => e.content)).toEqual([
      'compact summary',
      'keep me',
      'after',
    ]);
    log.seed(actual.maxEid);
    expect(log.append({ type: 'assistant', content: 'next' })).toBe(267);
    await log.flush();
  });
  it('checks cancellation while replaying, not only when opening the file', async () => {
    const { cwd, dir } = await fixture();
    await writeFile(join(dir, 'session-100.jsonl'), '{"eid":1}\n{"eid":2}\n');
    const stop = new AbortController();
    const log = await openHostedInkLog({
      cwd,
      sessionId: 'session',
      signal: stop.signal,
      project: () => {},
      register: () => {},
    });
    const stream = ((await log.read()) as AsyncIterable<Record<string, unknown>>)[
      Symbol.asyncIterator
    ]();
    expect((await stream.next()).value).toEqual({ eid: 1 });
    stop.abort();
    await expect(stream.next()).rejects.toThrow();
  });
  it('rejects paths outside its own clone namespace and invalid session ids', async () => {
    const { cwd, dir } = await fixture();
    const parent = join(dir, 'session-100.jsonl');
    for (const path of [
      parent,
      join(dir, 'other.clone-1.jsonl'),
      join(cwd, 'session-100.clone-1.jsonl'),
    ])
      expect(() => hostedCloneLog(parent, path)).toThrow();
    await expect(
      openHostedInkLog({ cwd, sessionId: '../../other', project: () => {}, register: () => {} })
    ).rejects.toThrow();
  });
});

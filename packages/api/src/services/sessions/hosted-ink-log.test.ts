import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { openHostedInkLog, hostedCloneLog } from './hosted-ink-log';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
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
    expect(await log.read()).toEqual([{ eid: 7, type: 'assistant', text: 'prior' }]);
    log.seed(7);
    expect(log.append({ type: 'assistant', text: 'new' })).toBe(8);
    expect(project).not.toHaveBeenCalled();
    await log.flush();
    expect(project).toHaveBeenCalledWith(expect.objectContaining({ eid: 8, text: 'new' }));
    expect((await log.read()).map((x) => x.eid)).toEqual([7, 8]);
    expect(register).toHaveBeenCalledWith(parent);
    const clone = hostedCloneLog(parent, parent.replace('.jsonl', '.clone-2.jsonl'));
    clone.append({ type: 'clone_start' });
    await clone.flush();
    expect(await readFile(clone.path, 'utf8')).toContain('clone_start');
    expect(project).toHaveBeenCalledTimes(1);
  });
  it('streams chunked UTF-8 and refuses oversized replay rather than silently losing context', async () => {
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
    expect((await log.read())[0].text).toBe(text);
    await writeFile(
      path,
      JSON.stringify({ type: 'assistant', text: 'x'.repeat(1024 * 1024 + 1) }) + '\n'
    );
    await expect(log.read()).rejects.toThrow('entry exceeds');
    await writeFile(
      path,
      (JSON.stringify({ type: 'assistant', text: 'x'.repeat(32768) }) + '\n').repeat(260)
    );
    await expect(log.read()).rejects.toThrow('replay byte bound');
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

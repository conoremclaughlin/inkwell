/**
 * The macOS branch of the launch-tag scan, against synthetic `ps` listings:
 * the two listings are separate snapshots, so a process that changed or
 * appeared between them is unresolved, and only the first variable is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listings = vi.hoisted(() => ({
  plain: [
    '  200   200 /x/claude --print',
    '  201   201 /x/codex exec',
    '  202   202 /x/claude -p',
    '  204   204 /x/claude --print',
    '  205   205 /x/agy chat',
    '  206   206 <defunct>',
    '  207   207 /opt/bin/claude',
  ].join('\n'),
  env: [
    '  200   200 /x/claude --print INK_LAUNCH_ID=row-1 HOME=/h',
    // Its arguments changed between the snapshots.
    '  201   201 /x/codex resume abc HOME=/h INK_LAUNCH_ID=row-2',
    // 202 is only in the plain snapshot; 203 only in this one.
    '  203   203 /x/gemini -p HOME=/h',
    // The tag's text inside another variable's value, not first.
    '  204   204 /x/claude --print FIXTURE_NOTE=prefix INK_LAUNCH_ID=row-4 suffix',
    // Nothing after the arguments: environment hidden.
    '  205   205 /x/agy chat',
    '  206   206 <defunct>',
    // Its arguments grew between the snapshots: `--print` is no variable.
    '  207   207 /opt/bin/claude --print INK_LAUNCH_ID=row-7 HOME=/h',
  ].join('\n'),
  // The second look, at the processes that were inconsistent: 201 changed
  // again, 203 now reads cleanly, and 202 has exited.
  plainAgain: [
    '  201   201 /x/codex resume abc',
    '  203   203 /x/gemini -p',
    '  207   207 /opt/bin/claude --print',
  ].join('\n'),
  envAgain: [
    '  201   201 /x/codex exec --again HOME=/h',
    '  203   203 /x/gemini -p HOME=/h',
    '  207   207 /opt/bin/claude --print INK_LAUNCH_ID=row-7 HOME=/h',
  ].join('\n'),
  selectors: [] as string[][],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const util = await import('util');
  const execFile = Object.assign(vi.fn(), {
    [util.promisify.custom]: async (_file: string, args: string[]) => {
      listings.selectors.push(args);
      const again = args.includes('-p');
      const env = args.includes('-E');
      return {
        stdout: again
          ? env
            ? listings.envAgain
            : listings.plainAgain
          : env
            ? listings.env
            : listings.plain,
        stderr: '',
      };
    },
  });
  return { ...actual, execFile };
});

import { findTaggedProcesses } from './launched-processes';

describe('findTaggedProcesses on macOS', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('reads only a first-variable tag, and keeps changed or unmatched processes unresolved', async () => {
    const inventory = await findTaggedProcesses(new Set(['row-1', 'row-2', 'row-4', 'row-7']));
    expect([...inventory.tagged.entries()]).toEqual([
      ['row-1', [{ pid: 200, pgid: 200, command: '/x/claude --print' }]],
      // Read on the second look, once both listings agree.
      ['row-7', [{ pid: 207, pgid: 207, command: '/opt/bin/claude --print' }]],
    ]);
    // Looked at once more: only 201 is still inconsistent.
    expect(
      listings.selectors.filter((args) => args.includes('-p')).map((a) => a[a.indexOf('-p') + 1])
    ).toEqual(['201,203,207,202', '201,203,207,202']);
    expect(inventory.unreadable).toEqual([
      { pid: 205, pgid: 205, command: '/x/agy chat' },
      { pid: 201, pgid: 201, command: '/x/codex resume abc' },
    ]);
  });
});

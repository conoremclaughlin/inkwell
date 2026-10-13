import { afterEach, it, expect } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverHostedSkillMcpServers } from './skill-mcp-discovery.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it('keeps repo/home order, nesting, names and parsed config without ambient roots', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ink-skills-')));
  roots.push(root);
  const cwd = join(root, 'cwd'),
    home = join(root, 'home');
  const put = async (path: string, name: string) => {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, 'SKILL.md'),
      `---\nname: test\nmcp:\n  name: ${name}\n  command: node\n  args: [server.js]\n---\n`
    );
  };
  await put(join(cwd, '.ink', 'skills', 'z'), 'last');
  await put(join(cwd, '.codex', 'skills', 'a'), 'repo');
  await put(join(home, '.codex', 'skills', 'a'), 'home');
  await put(join(home, '.gemini', 'skills', 'nested', '.system', 'b'), 'nested');
  expect((await discoverHostedSkillMcpServers(cwd, home)).map((s) => s.name)).toEqual([
    'repo',
    'home',
    'nested',
    'last',
  ]);
  expect(
    await discoverHostedSkillMcpServers(join(root, 'empty'), join(root, 'also-empty'))
  ).toEqual([]);
});

import { describe, expect, it } from 'vitest';
import { parseSkillMcpContent } from './skill-mcp-parser.js';

const skill = (properties: string) =>
  `---\nname: fixture\nmcp:\n  name: fixture-server\n  command: npx\n${properties}\n---\n# body`;
describe('skill MCP line parser', () => {
  it('preserves inline args/env and the final property without a trailing newline', () => {
    expect(
      parseSkillMcpContent(skill('  args: ["package", \'--flag\']\n  env: {KEY: "value"}'))
    ).toEqual({
      name: 'fixture-server',
      command: 'npx',
      args: ['package', '--flag'],
      env: { KEY: 'value' },
    });
  });
  it('preserves block lists/maps, including values containing colons', () => {
    expect(
      parseSkillMcpContent(
        skill(
          '  args:\n    - "package"\n    - --flag\n  env:\n    URL: "https://fixture.invalid/a"\n    KEY: value'
        )
      )
    ).toEqual({
      name: 'fixture-server',
      command: 'npx',
      args: ['package', '--flag'],
      env: { URL: 'https://fixture.invalid/a', KEY: 'value' },
    });
  });
  it('does not consume adjacent top-level properties or nested mcp blocks', () => {
    expect(
      parseSkillMcpContent(skill('  args:\n    - first\nafter:\n  env: {BAD: bad}'))
    ).toMatchObject({ args: ['first'], env: undefined });
    expect(
      parseSkillMcpContent('---\nouter:\n  mcp:\n    name: nested\n    command: wrong\n---')
    ).toBeNull();
    expect(parseSkillMcpContent(skill('  args: []\n  env: {}'))).toMatchObject({
      args: [],
      env: undefined,
    });
  });
  it.each(['args', 'env'])(
    'scans long whitespace and malformed %s blocks without backtracking',
    (key) => {
      const input = skill(`  ${key}:\n${'   \n'.repeat(20_000)}  !`);
      const start = performance.now();
      expect(parseSkillMcpContent(input)).toMatchObject({
        name: 'fixture-server',
        command: 'npx',
        args: [],
        env: undefined,
      });
      expect(performance.now() - start).toBeLessThan(1000);
    }
  );
  it('retains initial blank lines after mcp and missing-config refusal', () => {
    expect(parseSkillMcpContent('---\nmcp:  \n\n  name: n\n  command: c\n---')).toMatchObject({
      name: 'n',
      command: 'c',
    });
    expect(parseSkillMcpContent('no frontmatter')).toBeNull();
    expect(parseSkillMcpContent('---\nmcp:\n  name: incomplete\n---')).toBeNull();
  });
  it('does not backtrack within a tab-filled item followed by a Unicode line break', () => {
    const input = skill(`  args:\n    -\t${'\t'.repeat(60_000)}\u2028!`);
    const start = performance.now();
    expect(parseSkillMcpContent(input)).toMatchObject({ args: [] });
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('does not rescan malformed inline lists across subsequent properties', () => {
    const input = skill('  args: [\n'.repeat(20_000));
    const start = performance.now();
    expect(parseSkillMcpContent(input)).toMatchObject({ args: [] });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

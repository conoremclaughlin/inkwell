import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildLocalToolInstruction } from './chat.js';

/**
 * In local routing the model sees Inkwell's tools by name only, so it has to be
 * told where their parameters are, and a wrong guess has to come back with the
 * real ones. The helper is unit-tested in repl/tool-parameter-help.test.ts;
 * this pins the wiring: one lookup per run, given to both dispatchers, and an
 * instruction that names describe_tool for every audience.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'chat.ts'), 'utf8');

describe('Inkwell tool parameters in local routing', () => {
  it('builds one lookup per run, through describe_tool', () => {
    expect(source.match(/createToolParametersLookup\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /const inkToolParameters = createToolParametersLookup\(\(tool\) =>\s*inkClient\.callTool\('describe_tool', \{ name: tool \}\)\s*\);/
    );
  });

  it('gives it to both dispatchers, the parent turn and the clone', () => {
    expect(source.match(/createLocalToolDispatcher\(\{/g)).toHaveLength(2);
    expect(source.match(/toolParameters: inkToolParameters,/g)).toHaveLength(2);
  });

  it("asks each dispatcher's own policy, without spending a grant, before any lookup", () => {
    expect(source.match(/mayLookUpParameters: \(\) => \{/g)).toHaveLength(2);
    expect(source).toMatch(
      /mayLookUpParameters: \(\) => \{\s*const decision = opts\.policy\.inspectInkTool\('describe_tool', runtime\.sessionId\);\s*return decision\.allowed && !decision\.wouldConsumeGrant;\s*\}/
    );
    expect(source).toMatch(
      /mayLookUpParameters: \(\) => \{\s*const decision = toolPolicy\.inspectInkTool\('describe_tool', runtime\.sessionId\);\s*return decision\.allowed && !decision\.wouldConsumeGrant;\s*\}/
    );
  });

  it.each(['parent', 'clone'] as const)(
    'tells the %s how to list the tools and read their parameters',
    (audience) => {
      const text = buildLocalToolInstruction({ audience });
      expect(text).toContain('describe_tool({}) lists every Inkwell tool');
      expect(text).toContain('describe_tool({"name": "<tool>"}) for its exact parameters');
      expect(text).not.toMatch(/bootstrap, etc\./);
    }
  );

  it('names web_fetch to the parent, so reading a page needs no shell', () => {
    expect(buildLocalToolInstruction({ audience: 'parent' })).toContain('web_fetch');
  });
});

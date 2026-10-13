import { describe, expect, it } from 'vitest';
import { extractToolBlocks, stripLocalToolBlocks, runAgentLoop } from './agent-loop.js';
import { userFacingReplyText } from '../runner/turn-reply.js';

// Invented control-only outputs. No provider, process, account, or network is used.
const invocation =
  '<invoke name="signal_status">\n<parameter name="status">completed</parameter>\n</invoke>';

describe('runtime controls are not conversational replies', () => {
  it('reports an unsupported invoke as malformed, never executing it', () => {
    const result = extractToolBlocks(invocation);
    expect(result.calls).toEqual([]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].tool).toBe('signal_status');
  });

  it.each([
    invocation,
    '<invoke name="signal_status"></invoke>',
    `<function_calls>\n${invocation}\n</function_calls>`,
  ])('removes control-only output: %s', (text) => {
    expect(stripLocalToolBlocks(text)).toBe('');
    expect(userFacingReplyText(text)).toBeNull();
  });

  it('keeps the actual reply before a control block', () => {
    expect(userFacingReplyText(`The sample is ready.\n${invocation}`)).toBe('The sample is ready.');
  });

  it('does not treat a fenced XML example as a request', () => {
    const example = `An XML example:\n\`\`\`xml\n${invocation}\n\`\`\``;
    expect(extractToolBlocks(example).malformed).toEqual([]);
    expect(userFacingReplyText(example)).toBe(example);
  });

  it.each([
    '<antml:function_calls>\n<antml:invoke name="signal_status"></antml:invoke>\n</antml:function_calls>',
    '<invoke name="signal_status">\n<parameter name="status">completed',
    `${invocation}\n${invocation}`,
  ])('withholds namespaced, incomplete and repeated controls', (text) => {
    expect(userFacingReplyText(text)).toBeNull();
    expect(extractToolBlocks(text).calls).toEqual([]);
    expect(extractToolBlocks(text).malformed.length).toBeGreaterThan(0);
  });

  it('keeps text after a closed control and ignores inline XML discussion', () => {
    expect(userFacingReplyText(`${invocation}\nThe sample is ready.`)).toBe('The sample is ready.');
    const prose = 'The <invoke> tag is an example, not a tool call.';
    expect(userFacingReplyText(prose)).toBe(prose);
  });
});

it('feeds malformed XML back to a scripted backend without executing it', async () => {
  const prompts: string[] = [];
  const executed: string[] = [];
  const result = await runAgentLoop(
    { prompt: 'An invented greeting.', toolRouting: 'local', continueOnFailure: true },
    {
      ui: { printLine() {}, printEvent() {}, startWaiting: () => () => {} },
      backend: {
        runTurn: async (body) => {
          prompts.push(body);
          return {
            success: true,
            stdout: '',
            stderr: '',
            responseText: prompts.length === 1 ? invocation : 'A real conversational answer.',
          };
        },
      },
      tools: {
        execute: async (calls) => {
          executed.push(...calls.map((c) => c.tool));
          return [];
        },
      },
    }
  );
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('Unsupported invoke XML');
  expect(executed).toEqual([]);
  expect(result.assistantDisplayText).toBe('A real conversational answer.');
});

import { describe, it, expect } from 'vitest';
import { extractLocalToolCalls, stripLocalToolBlocks } from './chat.js';

/**
 * Tool-call format resilience (Myra regression, 2026-08-10): a long-lived
 * session whose history predates wholly-in-ink drifted into emitting
 * `<tool_call>{...}</tool_call>` XML text. Nothing executed, raw XML leaked
 * to Telegram via the fallback router, and text-form signal_status never
 * halted the continuation loop. The extractor now parses both formats.
 */
describe('extractLocalToolCalls — format resilience', () => {
  it('parses canonical ink-tool fences (unchanged)', () => {
    const calls = extractLocalToolCalls(
      'Let me check.\n```ink-tool\n{"tool":"get_inbox","args":{"agentId":"myra"}}\n```\ndone'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('get_inbox');
    expect(calls[0]!.args).toEqual({ agentId: 'myra' });
    expect(calls[0]!.variantFormat).toBeUndefined();
  });

  it('parses the <tool_call> XML variant, stripping the MCP namespace', () => {
    // Myra's exact emission shape from the incident.
    const calls = extractLocalToolCalls(
      'Let me send Conor the update.\n<tool_call>\n{"name": "mcp__inkwell__send_response", "arguments": {"content": "Checked your specs"}}\n</tool_call>'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('send_response');
    expect(calls[0]!.args).toEqual({ content: 'Checked your specs' });
    expect(calls[0]!.variantFormat).toBe(true);
  });

  it('maps a variant signal_status to the bare tool so the loop can halt', () => {
    const calls = extractLocalToolCalls(
      '<tool_call>{"name": "mcp__inkwell__signal_status", "arguments": {"status": "completed"}}</tool_call>'
    );
    expect(calls[0]!.tool).toBe('signal_status');
    expect(calls[0]!.args).toEqual({ status: 'completed' });
  });

  it('accepts bare names in the variant too', () => {
    const calls = extractLocalToolCalls(
      '<tool_call>{"name": "recall", "arguments": {"query": "x"}}</tool_call>'
    );
    expect(calls[0]!.tool).toBe('recall');
  });

  it('preserves emission order across mixed formats', () => {
    const calls = extractLocalToolCalls(
      '<tool_call>{"name":"recall","arguments":{}}</tool_call>\n' +
        'then\n```ink-tool\n{"tool":"get_inbox","args":{}}\n```\n' +
        '<tool_call>{"name":"mcp__inkwell__signal_status","arguments":{"status":"continuing"}}</tool_call>'
    );
    expect(calls.map((c) => c.tool)).toEqual(['recall', 'get_inbox', 'signal_status']);
  });

  it('skips malformed variant payloads without breaking the rest', () => {
    const calls = extractLocalToolCalls(
      '<tool_call>not json</tool_call>\n<tool_call>{"arguments":{}}</tool_call>\n' +
        '<tool_call>{"name":"remember","arguments":{"content":"ok"}}</tool_call>'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('remember');
  });
});

describe('stripLocalToolBlocks — both formats removed from display/routing text', () => {
  it('strips ink-tool fences and tool_call XML, leaving the prose', () => {
    const text =
      'Both steps passed.\n```ink-tool\n{"tool":"remember","args":{}}\n```\n' +
      '<tool_call>{"name":"mcp__inkwell__signal_status","arguments":{"status":"completed"}}</tool_call>\nReplying now.';
    expect(stripLocalToolBlocks(text)).toBe('Both steps passed.\n\n\nReplying now.');
  });

  it('a tool-syntax-only response strips to empty — nothing to leak to a channel', () => {
    expect(
      stripLocalToolBlocks(
        '<tool_call>{"name": "mcp__inkwell__signal_status", "arguments": {"status": "completed"}}</tool_call>'
      )
    ).toBe('');
  });
});

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

describe('ink-tool payloads containing ``` (embedded markdown fences)', () => {
  // Myra's IRA spec (2026-08-10): create_artifact content held markdown WITH
  // code fences. A first-``` regex truncated the JSON mid-string — the call
  // silently never ran AND the raw JSON tail (literal \n escapes, trailing
  // "}}") leaked into her rendered message.
  const artifactContent =
    '# IRA Strategy\n\nDecision tree:\n\n```\nIs AGI below the phase-out?\n├── YES → contribute directly\n└── NO → backdoor\n```\n\n| Strategy | Allowed |\n|---|---|\n| Spreads | Yes |\n';
  const block =
    '```ink-tool\n' +
    JSON.stringify({
      tool: 'create_artifact',
      args: { type: 'spec', uri: 'ink://specs/ira-options', content: artifactContent },
    }) +
    '\n```';

  it('parses the full JSON payload — the call executes instead of silently dropping', () => {
    const text = `Creating it properly now.\n\n${block}\n\nDone.`;
    const calls = extractLocalToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('create_artifact');
    expect((calls[0]!.args as { content: string }).content).toBe(artifactContent);
  });

  it('strips the entire block — no raw JSON tail leaks into the message', () => {
    const text = `Creating it properly now.\n\n${block}\n\nDone.`;
    const stripped = stripLocalToolBlocks(text);
    expect(stripped).toBe('Creating it properly now.\n\n\n\nDone.');
    expect(stripped).not.toContain('"}}');
    expect(stripped).not.toContain('backdoor');
  });

  it('keeps extraction and stripping aligned across mixed blocks', () => {
    const plain = '```ink-tool\n{"tool":"signal_status","args":{"status":"completed"}}\n```';
    const text = `Intro.\n${block}\nMiddle.\n${plain}\nOutro.`;
    const calls = extractLocalToolCalls(text);
    expect(calls.map((c) => c.tool)).toEqual(['create_artifact', 'signal_status']);
    const stripped = stripLocalToolBlocks(text);
    expect(stripped).toContain('Intro.');
    expect(stripped).toContain('Middle.');
    expect(stripped).toContain('Outro.');
    expect(stripped).not.toContain('ink-tool');
    expect(stripped).not.toContain('create_artifact');
  });

  it('accepts a scanned JSON block whose closing fence is missing (executes instead of leaking)', () => {
    const text = `Before.\n\`\`\`ink-tool\n{"tool":"remember","args":{"content":"has \`\`\` inside"}}\nAfter.`;
    const calls = extractLocalToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe('remember');
    const stripped = stripLocalToolBlocks(text);
    expect(stripped).toContain('Before.');
    expect(stripped).toContain('After.');
    expect(stripped).not.toContain('remember');
  });

  it('falls back to legacy first-fence handling for non-JSON payloads', () => {
    const text = 'A.\n```ink-tool\nnot json at all\n```\nB.';
    expect(extractLocalToolCalls(text)).toEqual([]);
    expect(stripLocalToolBlocks(text)).toBe('A.\n\nB.');
  });
});

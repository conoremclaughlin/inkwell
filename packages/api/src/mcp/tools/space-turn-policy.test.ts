import { describe, it, expect } from 'vitest';
import { SPACE_TURN_TOOLS, spaceTurnRefusal, spaceTurnRefusalResult } from './space-turn-policy';

const KEY = 'inkling:thread:fixture-group';
const spaceTurn = { tokenScope: 'mcp:space-turn', tokenThreadKey: KEY };

describe('the space-turn allowlist', () => {
  it('is exactly the two conversation tools', () => {
    expect([...SPACE_TURN_TOOLS]).toEqual(['get_thread_messages', 'send_response']);
  });

  it('lets both tools address the token’s own thread', () => {
    expect(spaceTurnRefusal('get_thread_messages', { threadKey: KEY }, spaceTurn)).toBeNull();
    expect(
      spaceTurnRefusal(
        'send_response',
        { channel: 'inkling', conversationId: KEY, content: 'hi' },
        spaceTurn
      )
    ).toBeNull();
  });

  it('refuses another thread, a missing thread and another channel', () => {
    const cases: Array<[string, unknown]> = [
      ['get_thread_messages', { threadKey: 'inkling:thread:someone-else' }],
      ['get_thread_messages', {}],
      ['get_thread_messages', undefined],
      ['send_response', { channel: 'inkling', conversationId: 'inkling:thread:someone-else' }],
      ['send_response', { channel: 'inkling' }],
      ['send_response', { channel: 'telegram', conversationId: KEY, content: 'hi' }],
      // A thread UUID is resolved server-side only once turns are wired; until
      // then it is not the signed key and is refused.
      [
        'send_response',
        { channel: 'inkling', conversationId: '00000000-0000-4000-8000-0000000000e1' },
      ],
    ];
    for (const [tool, args] of cases) {
      expect(spaceTurnRefusal(tool, args, spaceTurn), `${tool} ${JSON.stringify(args)}`).toEqual(
        expect.objectContaining({ code: 'space_turn_thread_mismatch' })
      );
    }
  });

  it('refuses every other tool, and a name no tool has', () => {
    for (const tool of ['recall', 'send_to_inbox', 'bootstrap', 'no_such_tool', '']) {
      expect(spaceTurnRefusal(tool, { threadKey: KEY }, spaceTurn)).toEqual(
        expect.objectContaining({ code: 'space_turn_tool_not_allowed' })
      );
    }
  });

  it('refuses an allowed tool when the token carries no thread', () => {
    expect(
      spaceTurnRefusal('get_thread_messages', { threadKey: KEY }, { tokenScope: 'mcp:space-turn' })
    ).toEqual(expect.objectContaining({ code: 'space_turn_thread_mismatch' }));
  });

  it('reads the narrow scope inside a scope set', () => {
    expect(
      spaceTurnRefusal(
        'recall',
        {},
        { tokenScope: 'mcp:tools mcp:space-turn', tokenThreadKey: KEY }
      )
    ).toEqual(expect.objectContaining({ code: 'space_turn_tool_not_allowed' }));
  });
});

describe('only the signed scope counts', () => {
  it('never refuses a broad token or a request with no token', () => {
    expect(spaceTurnRefusal('recall', {}, { tokenScope: 'mcp:tools' })).toBeNull();
    expect(spaceTurnRefusal('recall', {}, {})).toBeNull();
    expect(spaceTurnRefusal('recall', {}, undefined)).toBeNull();
  });

  it('ignores a scope or thread named in the call’s arguments', () => {
    // An argument claiming the narrow scope changes nothing for a broad token…
    expect(
      spaceTurnRefusal(
        'recall',
        { tokenScope: 'mcp:space-turn', scope: 'mcp:space-turn' },
        {
          tokenScope: 'mcp:tools',
        }
      )
    ).toBeNull();
    // …and an argument claiming a broad scope or another thread frees nothing.
    expect(
      spaceTurnRefusal('recall', { tokenScope: 'mcp:tools', scope: 'mcp:tools' }, spaceTurn)
    ).toEqual(expect.objectContaining({ code: 'space_turn_tool_not_allowed' }));
    expect(
      spaceTurnRefusal(
        'get_thread_messages',
        { threadKey: 'inkling:thread:someone-else', tokenThreadKey: 'inkling:thread:someone-else' },
        spaceTurn
      )
    ).toEqual(expect.objectContaining({ code: 'space_turn_thread_mismatch' }));
  });
});

describe('the refusal result', () => {
  it('is a classified tool error', () => {
    const result = spaceTurnRefusalResult({
      code: 'space_turn_tool_not_allowed',
      message: 'recall is not available in a shared conversation',
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: 'recall is not available in a shared conversation',
      code: 'space_turn_tool_not_allowed',
    });
  });
});

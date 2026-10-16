import { describe, it, expect, vi } from 'vitest';
import {
  SPACE_TURN_TOOLS,
  decideSpaceTurnCall,
  spaceTurnHandlerArgs,
  spaceTurnRefusal,
  spaceTurnRefusalResult,
} from './space-turn-policy';

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
    // The read pin refuses a stray tokenThreadKey before the thread is judged.
    expect(
      spaceTurnRefusal('recall', { tokenScope: 'mcp:tools', scope: 'mcp:tools' }, spaceTurn)
    ).toEqual(expect.objectContaining({ code: 'space_turn_tool_not_allowed' }));
    expect(
      spaceTurnRefusal(
        'get_thread_messages',
        { threadKey: 'inkling:thread:someone-else', tokenThreadKey: 'inkling:thread:someone-else' },
        spaceTurn
      )
    ).toEqual(expect.objectContaining({ code: 'space_turn_field_not_allowed' }));
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

// Phase 2 gate 5: send_response under space-turn carries only its channel,
// conversation and text, whatever the channel accepts later.
describe('the send_response field pin', () => {
  const ok = { channel: 'inkling', conversationId: KEY, content: 'hi' };

  it('allows exactly channel, conversationId and content', () => {
    expect(spaceTurnRefusal('send_response', ok, spaceTurn)).toBeNull();
    // A field left undefined carries nothing.
    expect(spaceTurnRefusal('send_response', { ...ok, format: undefined }, spaceTurn)).toBeNull();
  });

  it.each([
    ['media', [{ type: 'image', path: '/tmp/fixture.png' }]],
    ['voiceReply', true],
    ['ttsVoice', 'serena'],
    ['replyToMessageId', '00000000-0000-4000-8000-000000000099'],
    ['metadata', { attachment: 'fixture' }],
    ['format', 'markdown'],
  ])('refuses %s', (field, value) => {
    expect(spaceTurnRefusal('send_response', { ...ok, [field]: value }, spaceTurn)).toEqual(
      expect.objectContaining({ code: 'space_turn_field_not_allowed' })
    );
  });

  it('pins nothing for a broad token', () => {
    expect(
      spaceTurnRefusal(
        'send_response',
        { ...ok, media: [{ type: 'image' }] },
        { tokenScope: 'mcp:tools' }
      )
    ).toBeNull();
  });
});

// Phase 2 gate 3: get_thread_messages under space-turn reads as the token's
// own identity. No argument names another principal, and an sbSlug passes
// only naming the token's own SB; nothing here reads ENFORCE_IDENTITY_PINNING.
describe('the get_thread_messages identity pin', () => {
  const own = { ...spaceTurn, tokenSlug: 'fixture-inkling' };
  const read = { threadKey: KEY };

  it('keeps every read option', () => {
    expect(
      spaceTurnRefusal(
        'get_thread_messages',
        {
          threadKey: KEY,
          sbSlug: 'fixture-inkling',
          limit: 10,
          beforeMessageId: '00000000-0000-4000-8000-000000000098',
          afterMessageId: '00000000-0000-4000-8000-000000000097',
          includeSystemEvents: false,
          markRead: false,
          fullHistory: true,
          newerThan: '2026-10-15T00:00:00.000Z',
          latestN: 5,
          channelPoll: true,
        },
        own
      )
    ).toBeNull();
  });

  it.each([
    ['userId', '00000000-0000-4000-8000-0000000000a9'],
    ['email', 'someone@example.com'],
    ['phone', '+15555550123'],
    ['platform', 'telegram'],
    ['platformId', '100200300'],
  ])('refuses %s', (field, value) => {
    expect(spaceTurnRefusal('get_thread_messages', { ...read, [field]: value }, own)).toEqual(
      expect.objectContaining({ code: 'space_turn_field_not_allowed' })
    );
  });

  it('refuses an sbSlug that is not the token’s own, and any sbSlug when the token names none', () => {
    expect(
      spaceTurnRefusal('get_thread_messages', { ...read, sbSlug: 'fixture-other' }, own)
    ).toEqual(expect.objectContaining({ code: 'space_turn_field_not_allowed' }));
    expect(
      spaceTurnRefusal('get_thread_messages', { ...read, sbSlug: 'fixture-inkling' }, spaceTurn)
    ).toEqual(expect.objectContaining({ code: 'space_turn_field_not_allowed' }));
  });

  it('lets the token’s own sbSlug through', () => {
    expect(
      spaceTurnRefusal('get_thread_messages', { ...read, sbSlug: 'fixture-inkling' }, own)
    ).toBeNull();
  });

  it('pins nothing for a broad token', () => {
    expect(
      spaceTurnRefusal(
        'get_thread_messages',
        { ...read, userId: '00000000-0000-4000-8000-0000000000a9', sbSlug: 'fixture-other' },
        { tokenScope: 'mcp:tools' }
      )
    ).toBeNull();
  });
});

// Phase 2 gate 3: the thread the call names must resolve, the way the handler
// resolves it, to the signed thread id in the signed workspace.
describe('the canonical thread binding', () => {
  const THREAD = '00000000-0000-4000-8000-0000000000e1';
  const WORKSPACE = '00000000-0000-4000-8000-0000000000d1';
  const bound = { ...spaceTurn, tokenThreadId: THREAD, tokenWorkspaceId: WORKSPACE };
  const read = { threadKey: KEY };
  const reply = { channel: 'inkling', conversationId: KEY, content: 'hi' };

  it.each([
    ['get_thread_messages', read],
    ['send_response', reply],
  ] as const)('%s passes when the resolved thread is the signed one', async (tool, args) => {
    const resolve = vi.fn(async () => ({ id: THREAD, workspaceId: WORKSPACE }));
    expect(await decideSpaceTurnCall(tool, args, bound, resolve)).toEqual({
      allowed: true,
      thread: { id: THREAD, workspaceId: WORKSPACE },
    });
    expect(resolve).toHaveBeenCalledWith(tool, args);
  });

  it.each([
    ['the same key resolves in another workspace', { id: THREAD, workspaceId: 'workspace-other' }],
    ['the key resolves to another thread', { id: 'thread-other', workspaceId: WORKSPACE }],
  ])('refuses when %s', async (_label, thread) => {
    const decision = await decideSpaceTurnCall(
      'get_thread_messages',
      read,
      bound,
      async () => thread
    );
    expect(decision).toEqual({
      allowed: false,
      refusal: expect.objectContaining({ code: 'space_turn_thread_mismatch' }),
    });
  });

  it('refuses an unresolvable thread, and one whose lookup throws (ambiguous or unreadable)', async () => {
    for (const resolve of [
      async () => null,
      async () => {
        throw new Error('synthetic: more than one row');
      },
    ]) {
      expect(await decideSpaceTurnCall('get_thread_messages', read, bound, resolve)).toEqual({
        allowed: false,
        refusal: expect.objectContaining({ code: 'space_turn_thread_unresolved' }),
      });
    }
  });

  it('refuses when the token carries no thread id or workspace', async () => {
    const resolve = async () => ({ id: THREAD, workspaceId: WORKSPACE });
    for (const context of [
      { ...bound, tokenThreadId: undefined },
      { ...bound, tokenWorkspaceId: undefined },
    ]) {
      expect(await decideSpaceTurnCall('get_thread_messages', read, context, resolve)).toEqual({
        allowed: false,
        refusal: expect.objectContaining({ code: 'space_turn_thread_mismatch' }),
      });
    }
  });

  it('never looks up a thread for a call already refused, or for a broad token', async () => {
    const resolve = vi.fn(async () => ({ id: THREAD, workspaceId: WORKSPACE }));
    await decideSpaceTurnCall('recall', { query: 'x' }, bound, resolve);
    await decideSpaceTurnCall(
      'get_thread_messages',
      { threadKey: 'inkling:thread:other' },
      bound,
      resolve
    );
    expect(await decideSpaceTurnCall('recall', {}, { tokenScope: 'mcp:tools' }, resolve)).toEqual({
      allowed: true,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('hands send_response the resolved thread id, and leaves get_thread_messages as it is', () => {
    const thread = { id: THREAD, workspaceId: WORKSPACE };
    expect(spaceTurnHandlerArgs('send_response', [reply, { extra: 1 }], thread)).toEqual([
      { ...reply, conversationId: THREAD },
      { extra: 1 },
    ]);
    const readArgs = [read, {}];
    expect(spaceTurnHandlerArgs('get_thread_messages', readArgs, thread)).toBe(readArgs);
  });
});

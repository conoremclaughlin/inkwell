import { describe, expect, it, vi } from 'vitest';
import {
  callWithParameterHelp,
  createToolParametersLookup,
  describeParameters,
  isValidationError,
  parseDescribedParameters,
  unknownKeys,
  type ToolParameters,
} from './tool-parameter-help.js';

/** describe_tool({ name })'s answer, as InkClient parses it. */
const described = (
  name: string,
  properties: string[],
  required: string[] = [],
  strict = true
): Record<string, unknown> => ({
  success: true,
  tool: {
    name,
    description: '…',
    parameters: {
      type: 'object',
      properties: Object.fromEntries(properties.map((p) => [p, { type: 'string' }])),
      ...(required.length > 0 ? { required } : {}),
      ...(strict ? { additionalProperties: false } : {}),
    },
  },
});

const SEND_TO_INBOX = described(
  'send_to_inbox',
  ['content', 'recipientSlug', 'threadKey', 'senderSlug'],
  ['content']
);
const LIST_EMAILS = described('list_emails', ['query', 'maxResults', 'labelIds']);
const SAVE_IDENTITY = described(
  'save_identity',
  ['agentId', 'name', 'role', 'description'],
  ['agentId', 'name', 'role']
);
const SEND_LEGACY = described('send_legacy', ['content', 'senderSlug'], ['content'], false);

/** What the server's strict schema refusal looks like by the time InkClient throws it. */
const refusal = (tool: string, detail: string) =>
  new Error(
    `Inkwell tool call failed: Input validation error: Invalid arguments for tool ${tool}: ${detail}`
  );

const lookupOf = (answers: Record<string, unknown>) =>
  createToolParametersLookup(async (tool) => answers[tool]);

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

describe('parseDescribedParameters', () => {
  it("reads describe_tool's schema: names in order, the required ones, and strictness", () => {
    expect(parseDescribedParameters(SEND_TO_INBOX)).toEqual({
      names: ['content', 'recipientSlug', 'threadKey', 'senderSlug'],
      required: ['content'],
      strict: true,
    });
    expect(parseDescribedParameters(SEND_LEGACY)?.strict).toBe(false);
  });

  it('is undefined for a not-found, a bare object, or something that is not a schema', () => {
    expect(
      parseDescribedParameters({ success: false, error: 'No tool named "x"' })
    ).toBeUndefined();
    expect(parseDescribedParameters({ tool: { parameters: { properties: [] } } })).toBeUndefined();
    expect(parseDescribedParameters('text')).toBeUndefined();
    expect(parseDescribedParameters(undefined)).toBeUndefined();
  });
});

describe('the pieces', () => {
  const p: ToolParameters = {
    names: ['content', 'threadKey'],
    required: ['content'],
    strict: true,
  };

  it('names each parameter and marks the required ones', () => {
    expect(describeParameters('send_to_inbox', p)).toBe(
      'Parameters of send_to_inbox: content (required), threadKey.'
    );
    expect(describeParameters('get_timezone', { names: [], required: [], strict: true })).toBe(
      'get_timezone takes no parameters.'
    );
  });

  it('finds the keys the tool has no parameter for', () => {
    expect(unknownKeys({ content: 'Hi', sbSlug: 'kin' }, p)).toEqual(['sbSlug']);
  });

  it('recognises the server validation refusal and nothing else', () => {
    expect(isValidationError(refusal('send_to_inbox', 'x').message)).toBe(true);
    expect(isValidationError('MCP error -32602: Invalid datetime at runAt')).toBe(true);
    expect(isValidationError('Inkwell tool call failed: Thread not found')).toBe(false);
  });
});

describe('callWithParameterHelp — a validation error carries the real parameters', () => {
  it('Oct 7: send_to_inbox with sbSlug names the parameters and the key that is not one', async () => {
    const error = await thrown(
      callWithParameterHelp(
        'send_to_inbox',
        { threadKey: 'chat:c1', sbSlug: 'kin', content: 'Hi' },
        async () => {
          throw refusal('send_to_inbox', "Unrecognized key(s) in object: 'sbSlug'");
        },
        lookupOf({ send_to_inbox: SEND_TO_INBOX })
      )
    );
    expect(error.message).toContain("Unrecognized key(s) in object: 'sbSlug'");
    expect(error.message).toContain(
      'Parameters of send_to_inbox: content (required), recipientSlug, threadKey, senderSlug.'
    );
    expect(error.message).toContain('Not parameters of send_to_inbox: sbSlug.');
  });

  it("Myra's list_emails with searchQuery is pointed at query", async () => {
    const error = await thrown(
      callWithParameterHelp(
        'list_emails',
        { searchQuery: 'from:example.com' },
        async () => {
          throw refusal('list_emails', "Unrecognized key(s) in object: 'searchQuery'");
        },
        lookupOf({ list_emails: LIST_EMAILS })
      )
    );
    expect(error.message).toContain('Parameters of list_emails: query, maxResults, labelIds.');
    expect(error.message).toContain('Not parameters of list_emails: searchQuery.');
  });

  it("Myra's save_identity without name and role names what is required, with no stray-key clause", async () => {
    const error = await thrown(
      callWithParameterHelp(
        'save_identity',
        { agentId: 'myra' },
        async () => {
          throw refusal('save_identity', 'name: Required; role: Required');
        },
        lookupOf({ save_identity: SAVE_IDENTITY })
      )
    );
    expect(error.message).toContain(
      'Parameters of save_identity: agentId (required), name (required), role (required), description.'
    );
    expect(error.message).not.toContain('Not parameters');
  });

  it('leaves an error that is not a validation refusal exactly as it was', async () => {
    const original = new Error('Inkwell tool call failed: Thread not found');
    const error = await thrown(
      callWithParameterHelp(
        'send_to_inbox',
        { sbSlug: 'kin' },
        async () => {
          throw original;
        },
        lookupOf({ send_to_inbox: SEND_TO_INBOX })
      )
    );
    expect(error).toBe(original);
  });

  it('leaves the refusal exactly as it was when the parameters cannot be looked up', async () => {
    const original = refusal('send_to_inbox', "Unrecognized key(s) in object: 'sbSlug'");
    const lookup = createToolParametersLookup(async () => {
      throw new Error('server down');
    });
    const error = await thrown(
      callWithParameterHelp(
        'send_to_inbox',
        { sbSlug: 'kin' },
        async () => {
          throw original;
        },
        lookup
      )
    );
    expect(error).toBe(original);
  });
});

describe('callWithParameterHelp — a success notes a key the tool ignored', () => {
  it('#539 shape: a non-strict tool that dropped an unknown key says so, and keeps its result', async () => {
    const result = await callWithParameterHelp(
      'send_legacy',
      { content: 'Hi', senderAgentId: 'system' },
      async () => ({ success: true, messageId: 'm1' }),
      lookupOf({ send_legacy: SEND_LEGACY })
    );
    expect(result).toMatchObject({ success: true, messageId: 'm1' });
    expect(result.ignoredParameters).toEqual({
      names: ['senderAgentId'],
      note: 'senderAgentId is not a parameter of send_legacy and had no effect. Parameters of send_legacy: content (required), senderSlug.',
    });
  });

  it('adds nothing for a strict tool, or when every key is a parameter', async () => {
    const strictResult = { success: true };
    expect(
      await callWithParameterHelp(
        'send_to_inbox',
        { content: 'Hi', extra: 1 },
        async () => strictResult,
        lookupOf({ send_to_inbox: SEND_TO_INBOX })
      )
    ).toBe(strictResult);
    const cleanResult = { success: true };
    expect(
      await callWithParameterHelp(
        'send_legacy',
        { content: 'Hi' },
        async () => cleanResult,
        lookupOf({ send_legacy: SEND_LEGACY })
      )
    ).toBe(cleanResult);
  });

  it('returns the result untouched when the lookup is slower than the wait', async () => {
    const result = { success: true };
    const never = createToolParametersLookup(() => new Promise(() => {}));
    expect(
      await callWithParameterHelp('send_legacy', { stray: 1 }, async () => result, never, 5)
    ).toBe(result);
  });

  it('without a lookup, the call goes out bare', async () => {
    const result = { success: true };
    expect(await callWithParameterHelp('recall', { q: 1 }, async () => result, undefined)).toBe(
      result
    );
  });
});

describe('createToolParametersLookup', () => {
  it('asks describe_tool once per tool', async () => {
    const describe = vi.fn(async () => SEND_TO_INBOX);
    const lookup = createToolParametersLookup(describe);
    await lookup('send_to_inbox');
    await lookup('send_to_inbox');
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed lookup, so a later call can try again', async () => {
    const describe = vi
      .fn<(tool: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(SEND_TO_INBOX);
    const lookup = createToolParametersLookup(describe);
    expect(await lookup('send_to_inbox')).toBeUndefined();
    expect((await lookup('send_to_inbox'))?.required).toEqual(['content']);
    expect(describe).toHaveBeenCalledTimes(2);
  });
});

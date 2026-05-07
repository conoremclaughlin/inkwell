import { describe, expect, it } from 'vitest';
import { parseReflectedOutput } from './spawn-reflect.js';

describe('parseReflectedOutput', () => {
  it('extracts reflected context from a single marker line', () => {
    const stdout = [
      'some banner noise',
      'PCP_DEBUG_RESULT: {"transport":"http","pinnedAgentId":"wren","requestContext":{"agentId":"wren","runtime":"claude"},"sessionContext":null}',
    ].join('\n');

    const parsed = parseReflectedOutput(stdout);
    expect(parsed.transport).toBe('http');
    expect(parsed.pinnedAgentId).toBe('wren');
    expect(parsed.requestContext).toEqual({ agentId: 'wren', runtime: 'claude' });
    expect(parsed.sessionContext).toBeNull();
  });

  it('tolerates leading whitespace before the marker', () => {
    const stdout =
      '   PCP_DEBUG_RESULT: {"transport":"stdio","pinnedAgentId":null,"requestContext":null,"sessionContext":null}';
    const parsed = parseReflectedOutput(stdout);
    expect(parsed.transport).toBe('stdio');
  });

  it('throws a helpful error when the marker is absent', () => {
    expect(() => parseReflectedOutput('I have no idea what you are asking\n')).toThrow(
      /debug_request marker not found/
    );
  });

  it('throws when the backend reports UNAVAILABLE', () => {
    expect(() => parseReflectedOutput('PCP_DEBUG_RESULT: UNAVAILABLE')).toThrow(
      /tool unavailable/i
    );
  });

  it('throws when the payload after the marker is not JSON', () => {
    expect(() => parseReflectedOutput('PCP_DEBUG_RESULT: not json')).toThrow(
      /Could not parse JSON/
    );
  });
});

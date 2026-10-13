import { describe, expect, it } from 'vitest';
import { parseJsonRpcResponse } from './mcp-result.js';
const result = { jsonrpc: '2.0', id: 1, result: { ok: true } };
describe('JSON-RPC response framing', () => {
  it('preserves JSON and SSE framing after comments and blank lines', () => {
    expect(parseJsonRpcResponse(` ${JSON.stringify(result)} `)).toEqual(result);
    expect(
      parseJsonRpcResponse(`: keepalive\n\n event: message\ndata: ${JSON.stringify(result)}\n\n`)
    ).toEqual(result);
    expect(parseJsonRpcResponse(`event: message\ndata: ${JSON.stringify(result)}\n\n`)).toEqual(
      result
    );
  });
  it('does not mistake a JSON string for a framing line', () => {
    expect(parseJsonRpcResponse('{"result":"\\ndata: still JSON"}')).toEqual({
      result: '\ndata: still JSON',
    });
  });
  it('rejects malformed payloads with a long run of newlines in linear time', () => {
    const start = performance.now();
    expect(() => parseJsonRpcResponse(`!${'\n'.repeat(80_000)}!`)).toThrow();
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('finds valid SSE following a long run of blank lines', () => {
    const start = performance.now();
    expect(
      parseJsonRpcResponse(`: heartbeat${'\n'.repeat(80_000)}data: ${JSON.stringify(result)}\n\n`)
    ).toEqual(result);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

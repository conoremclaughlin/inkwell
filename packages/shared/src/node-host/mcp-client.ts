/** Session-bound MCP, without organic auth fallback or retries of unknown effects. */
import { parseJsonRpcResponse, parseJsonRpcToolPayload } from '../runtime/mcp-result.js';

export function createHostedMcpClient(input: {
  url: string;
  context: string;
  accessToken(): string | Promise<string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}) {
  const url = new URL(input.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Hosted MCP requires an explicit HTTP URL without embedded credentials');
  const timeoutMs = input.timeoutMs ?? 300_000;
  const maxBytes = input.maxResponseBytes ?? 32 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw new Error('Hosted MCP limits must be positive safe integers');
  let id = 0;
  return {
    async headers() {
      const token = await input.accessToken();
      if (!token.trim()) throw new Error('Hosted MCP has no admitted credential');
      return { Authorization: `Bearer ${token}`, 'x-ink-context': input.context };
    },
    async callTool(name: string, args: Record<string, unknown>, options: { signal: AbortSignal }) {
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
      signal.throwIfAborted();
      const headers = await this.headers();
      signal.throwIfAborted();
      const response = await (input.fetch ?? globalThis.fetch)(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name, arguments: args },
          id: ++id,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Hosted MCP refused the call (${response.status})`);
      }
      if (!response.body) throw new Error('Hosted MCP returned no body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > maxBytes) throw new Error('Hosted MCP response exceeds its byte bound');
          chunks.push(item.value);
        }
        signal.throwIfAborted();
        return parseJsonRpcToolPayload(
          parseJsonRpcResponse(Buffer.concat(chunks).toString('utf8'))
        );
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}

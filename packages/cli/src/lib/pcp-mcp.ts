import { getValidAccessToken } from '../auth/tokens.js';

let jsonRpcId = 1;

export function getPcpServerUrl(): string {
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
}

export async function callPcpTool<T = Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number }
): Promise<T> {
  const serverUrl = getPcpServerUrl();
  const url = `${serverUrl}/mcp`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  const token = await getValidAccessToken(serverUrl);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: tool, arguments: args },
      id: jsonRpcId++,
    }),
    ...(options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
  });

  if (!response.ok) {
    throw new Error(`PCP call failed (${response.status}): ${await response.text()}`);
  }

  const contentType = response.headers.get('content-type') || '';
  let payload: Record<string, unknown>;

  if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    const lastData = dataLines[dataLines.length - 1];
    if (!lastData) {
      throw new Error('PCP SSE response contained no data lines');
    }
    payload = JSON.parse(lastData) as Record<string, unknown>;
  } else {
    payload = (await response.json()) as Record<string, unknown>;
  }

  if (payload.error) {
    const err = payload.error as { message?: string; code?: number };
    throw new Error(`PCP tool error (${err.code}): ${err.message}`);
  }

  const result = payload.result as { content?: Array<{ text?: string }> } | undefined;
  const mcpText = result?.content?.[0]?.text;

  if (typeof mcpText === 'string') {
    try {
      return JSON.parse(mcpText) as T;
    } catch {
      return { text: mcpText } as unknown as T;
    }
  }

  return (result as unknown as T) ?? (payload as unknown as T);
}

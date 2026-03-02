import { getValidAccessToken } from '../auth/tokens.js';
import { sbDebugLog } from './sb-debug.js';

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
  sbDebugLog('pcp-mcp', 'call_start', {
    tool,
    serverUrl,
    timeoutMs: options?.timeoutMs ?? null,
    argKeys: Object.keys(args),
  });

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
    const body = await response.text();
    sbDebugLog('pcp-mcp', 'call_http_error', {
      tool,
      status: response.status,
      bodySnippet: body.slice(0, 300),
    });
    throw new Error(`PCP call failed (${response.status}): ${body}`);
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
      sbDebugLog('pcp-mcp', 'call_sse_empty', { tool });
      throw new Error('PCP SSE response contained no data lines');
    }
    payload = JSON.parse(lastData) as Record<string, unknown>;
  } else {
    payload = (await response.json()) as Record<string, unknown>;
  }

  if (payload.error) {
    const err = payload.error as { message?: string; code?: number };
    sbDebugLog('pcp-mcp', 'call_rpc_error', {
      tool,
      code: err.code ?? null,
      message: err.message ?? null,
    });
    throw new Error(`PCP tool error (${err.code}): ${err.message}`);
  }

  const result = payload.result as { content?: Array<{ text?: string }> } | undefined;
  const mcpText = result?.content?.[0]?.text;

  if (typeof mcpText === 'string') {
    try {
      const parsed = JSON.parse(mcpText) as T;
      sbDebugLog('pcp-mcp', 'call_success', {
        tool,
        mode: 'json-content',
      });
      return parsed;
    } catch {
      sbDebugLog('pcp-mcp', 'call_success', {
        tool,
        mode: 'text-content',
      });
      return { text: mcpText } as unknown as T;
    }
  }

  sbDebugLog('pcp-mcp', 'call_success', {
    tool,
    mode: 'raw-result',
  });
  return (result as unknown as T) ?? (payload as unknown as T);
}

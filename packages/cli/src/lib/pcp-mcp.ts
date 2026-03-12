import { getValidAccessToken } from '../auth/tokens.js';
import { sbDebugLog } from './sb-debug.js';

let jsonRpcId = 1;

function pickDebugArgValues(args: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'sessionId',
    'backendSessionId',
    'agentId',
    'backend',
    'studioId',
    'threadKey',
    'forceNew',
  ] as const;

  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined) picked[key] = args[key];
  }
  return picked;
}

export function getPcpServerUrl(): string {
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
}

function formatPcpFetchFailure(url: string, error: unknown): string {
  const base =
    error instanceof Error ? error.message.trim() || error.name : String(error || 'fetch failed');
  const err = error as { cause?: unknown } | undefined;
  const cause = err?.cause as
    | { code?: string; errno?: string | number; address?: string; port?: number; message?: string }
    | undefined;
  const causeParts: string[] = [];
  if (typeof cause?.code === 'string' && cause.code.trim()) causeParts.push(cause.code.trim());
  if (cause?.errno !== undefined && cause.errno !== null)
    causeParts.push(`errno=${String(cause.errno)}`);
  if (typeof cause?.address === 'string' && cause.address.trim())
    causeParts.push(`address=${cause.address.trim()}`);
  if (typeof cause?.port === 'number' && Number.isFinite(cause.port))
    causeParts.push(`port=${cause.port}`);
  if (typeof cause?.message === 'string' && cause.message.trim() && cause.message.trim() !== base) {
    causeParts.push(cause.message.trim());
  }

  const causeSuffix = causeParts.length > 0 ? ` (${causeParts.join(', ')})` : '';
  return `PCP fetch failed for ${url}: ${base}${causeSuffix}`;
}

export async function callPcpTool<T = Record<string, unknown>>(
  tool: string,
  args: Record<string, unknown>,
  options?: {
    timeoutMs?: number;
    callerProfile?: 'agent' | 'runtime';
    sessionId?: string;
    studioId?: string;
  }
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
  if (options?.callerProfile) {
    headers['x-pcp-caller-profile'] = options.callerProfile;
  }
  if (options?.sessionId) {
    headers['x-pcp-session-id'] = options.sessionId;
  }
  if (options?.studioId) {
    headers['x-pcp-studio-id'] = options.studioId;
  }

  sbDebugLog('pcp-mcp', 'call_start', {
    tool,
    serverUrl,
    timeoutMs: options?.timeoutMs || null,
    argKeys: Object.keys(args || {}),
    argValues: pickDebugArgValues(args || {}),
  });

  let response: Response;
  try {
    response = await fetch(url, {
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
  } catch (error) {
    const diagnostic = formatPcpFetchFailure(url, error);
    sbDebugLog('pcp-mcp', 'call_fetch_error', {
      tool,
      serverUrl,
      url,
      error: error instanceof Error ? error.message : String(error),
      diagnostic,
      cause:
        error && typeof error === 'object' && 'cause' in error
          ? String((error as { cause?: unknown }).cause)
          : null,
    });
    throw new Error(`${diagnostic}. Ensure PCP server is running and PCP_SERVER_URL is correct.`);
  }

  if (!response.ok) {
    const body = await response.text();
    sbDebugLog('pcp-mcp', 'call_http_error', {
      tool,
      serverUrl,
      status: response.status,
      statusText: response.statusText,
      responseBody: body.slice(0, 1500),
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
      sbDebugLog('pcp-mcp', 'call_sse_no_data', { tool, serverUrl });
      throw new Error('PCP SSE response contained no data lines');
    }
    payload = JSON.parse(lastData) as Record<string, unknown>;
    sbDebugLog('pcp-mcp', 'call_success', { tool, mode: 'sse' });
  } else {
    payload = (await response.json()) as Record<string, unknown>;
    sbDebugLog('pcp-mcp', 'call_success', { tool, mode: 'json-content' });
  }

  if (payload.error) {
    const err = payload.error as { message?: string; code?: number };
    sbDebugLog('pcp-mcp', 'call_tool_error', {
      tool,
      code: err.code ?? null,
      message: err.message ?? null,
    });
    throw new Error(`PCP tool error (${err.code}): ${err.message}`);
  }

  const result = payload.result as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
  if (result?.isError) {
    const rawText = result.content
      ?.map((entry) => (typeof entry?.text === 'string' ? entry.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    let message = rawText || 'Unknown MCP tool error';
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { error?: string; message?: string };
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
          message = parsed.error.trim();
        } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
          message = parsed.message.trim();
        }
      } catch {
        // Keep raw text message.
      }
    }

    sbDebugLog('pcp-mcp', 'call_result_error', {
      tool,
      message,
    });
    throw new Error(`PCP tool error: ${message}`);
  }

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

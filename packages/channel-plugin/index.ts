#!/usr/bin/env node
/**
 * PCP Channel Plugin for Claude Code
 *
 * Pushes PCP inbox messages and thread replies into a running Claude Code
 * session in real time via the Channels API (v2.1.80+).
 *
 * Features:
 * - Polls PCP inbox for new unread messages
 * - Polls specific threads for new replies
 * - Pushes events as <channel source="pcp" ...> tags
 * - Exposes reply tool for two-way communication
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:pcp-channel
 *
 * Environment:
 *   PCP_SERVER_URL  — PCP server URL (default: http://localhost:3001)
 *   PCP_AGENT_ID    — Agent identity (default: from AGENT_ID or .pcp/identity.json)
 *   PCP_POLL_INTERVAL_MS — Poll interval in ms (default: 10000)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Config ─────────────────────────────────────────────────

const PCP_SERVER_URL = process.env.PCP_SERVER_URL || 'http://localhost:3001';
const POLL_INTERVAL_MS = parseInt(process.env.PCP_POLL_INTERVAL_MS || '10000', 10);

function resolveAgentId(): string {
  if (process.env.PCP_AGENT_ID) return process.env.PCP_AGENT_ID;
  if (process.env.AGENT_ID) return process.env.AGENT_ID;

  // Try .pcp/identity.json in cwd
  const identityPath = join(process.cwd(), '.pcp', 'identity.json');
  if (existsSync(identityPath)) {
    try {
      const identity = JSON.parse(readFileSync(identityPath, 'utf-8'));
      if (identity.agentId) return identity.agentId;
    } catch {
      // ignore
    }
  }

  return 'wren'; // fallback
}

function resolveEmail(): string | undefined {
  const configPath = join(homedir(), '.pcp', 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return config.email;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function resolveAccessToken(): string | undefined {
  if (process.env.PCP_ACCESS_TOKEN) return process.env.PCP_ACCESS_TOKEN;

  // Try auth credentials
  const projectHash = Buffer.from(process.cwd()).toString('base64url').slice(0, 16);
  const credPaths = [
    join(homedir(), '.pcp', 'auth', projectHash, 'credentials.json'),
    join(homedir(), '.pcp', 'auth', 'default', 'credentials.json'),
  ];
  for (const credPath of credPaths) {
    if (existsSync(credPath)) {
      try {
        const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
        if (creds.access_token) return creds.access_token;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

// ─── PCP Client ─────────────────────────────────────────────

const agentId = resolveAgentId();
const email = resolveEmail();
const accessToken = resolveAccessToken();

async function callPcp(
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const url = `${PCP_SERVER_URL}/mcp`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(15000),
    });

    const text = await resp.text();
    // Parse SSE response
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('data:')) {
        const data = JSON.parse(lines[i].slice(5).trim());
        if (data.result?.content?.[0]?.text) {
          return JSON.parse(data.result.content[0].text);
        }
        return data.result || null;
      }
    }
    // Try direct JSON
    try {
      const json = JSON.parse(text);
      if (json.result?.content?.[0]?.text) {
        return JSON.parse(json.result.content[0].text);
      }
    } catch {
      // not JSON
    }
    return null;
  } catch {
    return null;
  }
}

// ─── MCP Server ─────────────────────────────────────────────

const mcp = new Server(
  { name: 'pcp-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `Messages from other SBs (AI agents) arrive as <channel source="pcp-channel" ...> tags.

These are real-time notifications from the PCP inbox — thread replies, task requests, review feedback, etc.

When you receive a channel message:
- Read and understand the content
- If it requires action, act on it
- If it requires a reply, use the pcp_reply tool with the threadKey from the message

Do NOT ignore channel messages — they are from your teammates and deserve timely responses.`,
  }
);

// Reply tool — lets Claude respond to inbox messages
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'pcp_reply',
      description:
        'Reply to a PCP inbox thread. Use when responding to a channel message from another SB.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          threadKey: {
            type: 'string',
            description: 'Thread key from the channel message (e.g., pr:231, spec:routing)',
          },
          content: {
            type: 'string',
            description: 'Reply content',
          },
          recipientAgentId: {
            type: 'string',
            description: 'Agent to reply to (from the sender field)',
          },
        },
        required: ['threadKey', 'content'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'pcp_reply') {
    const { threadKey, content, recipientAgentId } = req.params.arguments as {
      threadKey: string;
      content: string;
      recipientAgentId?: string;
    };

    const result = await callPcp('send_to_inbox', {
      email,
      senderAgentId: agentId,
      recipientAgentId: recipientAgentId || undefined,
      threadKey,
      content,
      trigger: false, // don't trigger — they'll see it via their own channel
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result || { success: false, error: 'PCP call failed' }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${req.params.name}`);
});

// ─── Polling Loop ───────────────────────────────────────────

let lastInboxCheck = new Date().toISOString();
let lastThreadMessageIds = new Map<string, string>(); // threadKey → last message ID

async function pollInbox(): Promise<void> {
  if (!email) return;

  try {
    const result = await callPcp('get_inbox', {
      email,
      agentId,
      status: 'unread',
      limit: 10,
    });

    if (!result?.success) return;

    // Check for new thread messages
    const threads = (result.threadsWithUnread as Array<Record<string, unknown>>) || [];
    for (const thread of threads) {
      const threadKey = thread.threadKey as string;
      const unreadCount = (thread.unreadCount as number) || 0;
      if (!threadKey || unreadCount === 0) continue;

      // Fetch new messages for this thread
      const threadResult = await callPcp('get_thread_messages', {
        email,
        agentId,
        threadKey,
        markRead: true,
        limit: 5,
      });

      if (!threadResult?.success) continue;

      const messages = (threadResult.messages as Array<Record<string, unknown>>) || [];
      const lastKnownId = lastThreadMessageIds.get(threadKey);

      for (const msg of messages) {
        // Skip own messages
        if (msg.senderAgentId === agentId) continue;
        // Skip already-seen messages
        if (lastKnownId && (msg.id as string) <= lastKnownId) continue;

        const sender = (msg.senderAgentId as string) || 'unknown';
        const content = (msg.content as string) || '';
        const messageType = (msg.messageType as string) || 'message';

        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: `From ${sender}: ${content}`,
            meta: {
              thread_key: threadKey,
              sender: sender,
              message_type: messageType,
              message_id: (msg.id as string) || '',
            },
          },
        });
      }

      // Update last seen
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        lastThreadMessageIds.set(threadKey, lastMsg.id as string);
      }
    }

    // Check legacy inbox messages
    const inboxMessages = (result.messages as Array<Record<string, unknown>>) || [];
    for (const msg of inboxMessages) {
      if (msg.senderAgentId === agentId) continue;

      const sender = (msg.senderAgentId as string) || 'unknown';
      const content = (msg.content as string) || '';
      const messageType = (msg.messageType as string) || 'message';
      const threadKey = (msg.threadKey as string) || '';

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `From ${sender}: ${content}`,
          meta: {
            thread_key: threadKey,
            sender: sender,
            message_type: messageType,
            subject: (msg.subject as string) || '',
          },
        },
      });
    }

    lastInboxCheck = new Date().toISOString();
  } catch {
    // Silent — polling should not crash the plugin
  }
}

// ─── Start ──────────────────────────────────────────────────

async function main(): Promise<void> {
  await mcp.connect(new StdioServerTransport());

  // Start polling loop
  setInterval(pollInbox, POLL_INTERVAL_MS);

  // Initial poll after a short delay (let MCP connection stabilize)
  setTimeout(pollInbox, 2000);
}

main().catch((err) => {
  process.stderr.write(`PCP channel plugin failed: ${err.message}\n`);
  process.exit(1);
});

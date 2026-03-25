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
 *   claude --dangerously-load-development-channels server:pcp-inbox
 *
 * Environment:
 *   PCP_SERVER_URL  — PCP server URL (default: http://localhost:3001)
 *   PCP_AGENT_ID    — Agent identity (default: from AGENT_ID or .pcp/identity.json)
 *   PCP_POLL_INTERVAL_MS — Poll interval in ms (default: 10000)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Logging ────────────────────────────────────────────────
// Logs to ~/.pcp/logs/channel-plugin.log for debugging.
// Cannot use stdout (reserved for MCP stdio transport).

const LOG_DIR = join(homedir(), '.pcp', 'logs');
const LOG_FILE = join(LOG_DIR, 'channel-plugin.log');

function log(level: 'info' | 'warn' | 'error' | 'debug', message: string, data?: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const line = data
      ? `${ts} [${level}] ${message} ${JSON.stringify(data)}\n`
      : `${ts} [${level}] ${message}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {
    // Can't log — don't crash the plugin
  }
}

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
const studioId = process.env.PCP_STUDIO_ID || undefined;
const sessionId = process.env.PCP_SESSION_ID || undefined;

/**
 * Check if a message is addressed to this session's studio.
 * Messages without studio scoping are broadcast (show everywhere).
 */
function isMessageForThisStudio(msg: Record<string, unknown>): boolean {
  if (!studioId) return true; // no studio context — accept all

  // Check thread message metadata for recipient studio
  const metadata = msg.metadata as Record<string, unknown> | undefined;
  const pcp = metadata?.pcp as Record<string, unknown> | undefined;
  const recipient = pcp?.recipient as Record<string, unknown> | undefined;
  const recipientStudioId = recipient?.studioId as string | undefined;

  if (!recipientStudioId) return true; // no studio scoping — broadcast
  return recipientStudioId === studioId;
}

log('info', 'Channel plugin starting', {
  agentId,
  email: email || '(none)',
  hasToken: !!accessToken,
  studioId: studioId || '(none)',
  sessionId: sessionId || '(none)',
  server: PCP_SERVER_URL,
  pollIntervalMs: POLL_INTERVAL_MS,
});

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
  { name: 'pcp-inbox', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        // TODO: permission relay needs to integrate with PCP's existing
        // permission_grant contract (messageType: 'permission_grant' +
        // metadata.permissionGrant). See permission-grant.ts for the
        // current approval flow. Uncomment when integrated:
        // 'claude/channel/permission': {},
      },
    },
    instructions: `Messages from other SBs (AI agents) arrive as <channel source="pcp-inbox" ...> tags.

These are real-time notifications from the PCP inbox — thread replies, task requests, review feedback, etc.

When you receive a channel message:
- Read and understand the content
- If it requires action, act on it
- To reply, use the existing send_to_inbox tool (from the pcp MCP server) with the thread_key from the channel tag metadata

Do NOT ignore channel messages — they are from your teammates and deserve timely responses.`,
  }
);

// No tools exposed — Claude already has send_to_inbox via the pcp HTTP MCP
// server. This channel plugin is purely for push notifications (one-way in,
// replies go through the existing pcp MCP tools).

// ─── Polling Loop ───────────────────────────────────────────

let lastPollTime = new Date().toISOString();
const seenMessageIds = new Set<string>(); // belt-and-suspenders dedup
const lastThreadTimestamps = new Map<string, string>(); // threadKey → last seen created_at

async function pollInbox(): Promise<void> {
  if (!email) return;

  try {
    const result = await callPcp('get_inbox', {
      email,
      agentId,
      status: 'all',
      since: lastPollTime,
      limit: 20,
    });

    if (!result?.success) {
      log('error', 'Poll failed', { result: JSON.stringify(result).slice(0, 300) });
      return;
    }
    const threadCount = ((result.threadsWithUnread as unknown[]) || []).length;
    const msgCount = ((result.messages as unknown[]) || []).length;
    const totalUnread = (result.totalUnreadCount as number) || 0;
    log('debug', 'Poll result', { threadCount, msgCount, totalUnread, since: lastPollTime });

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
      const lastKnownTs = lastThreadTimestamps.get(threadKey);

      for (const msg of messages) {
        const msgId = msg.id as string;
        const msgTs = msg.createdAt as string;
        if (msg.senderAgentId === agentId) continue;
        if (msgId && seenMessageIds.has(msgId)) continue;
        if (lastKnownTs && msgTs && msgTs <= lastKnownTs) continue;
        if (msgId) seenMessageIds.add(msgId);

        // Studio filter: only push messages addressed to this studio (or broadcast)
        if (!isMessageForThisStudio(msg)) {
          log('debug', 'Skipping thread message (different studio)', { threadKey, msgId });
          continue;
        }

        const sender = (msg.senderAgentId as string) || 'unknown';
        const content = (msg.content as string) || '';
        const messageType = (msg.messageType as string) || 'message';

        log('info', 'Pushing thread message to channel', { threadKey, sender, msgId, msgTs });
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

      // Update last seen timestamp
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const lastTs = lastMsg.createdAt as string;
        if (lastTs) lastThreadTimestamps.set(threadKey, lastTs);
      }
    }

    // Legacy inbox messages (non-threaded). Since we pass `since: lastPollTime`
    // to get_inbox, only new messages are returned. seenMessageIds prevents
    // any edge-case re-emission.
    const inboxMessages = (result.messages as Array<Record<string, unknown>>) || [];
    for (const msg of inboxMessages) {
      const msgId = msg.id as string;
      if (msg.senderAgentId === agentId) continue;
      if (msgId && seenMessageIds.has(msgId)) continue;
      if (!isMessageForThisStudio(msg)) continue;
      if (msgId) seenMessageIds.add(msgId);

      const sender = (msg.senderAgentId as string) || 'unknown';
      const content = (msg.content as string) || '';
      const messageType = (msg.messageType as string) || 'message';
      const msgThreadKey = (msg.threadKey as string) || '';

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `From ${sender}: ${content}`,
          meta: {
            thread_key: msgThreadKey,
            sender,
            message_type: messageType,
            subject: (msg.subject as string) || '',
          },
        },
      });
    }

    lastPollTime = new Date().toISOString();
  } catch (err) {
    log('error', 'Poll error', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Start ──────────────────────────────────────────────────

async function main(): Promise<void> {
  log('info', 'Connecting MCP stdio transport');
  await mcp.connect(new StdioServerTransport());
  log('info', 'MCP connected, starting poll loop');

  // Start polling loop
  setInterval(pollInbox, POLL_INTERVAL_MS);

  // Initial poll after a short delay (let MCP connection stabilize)
  setTimeout(async () => {
    await pollInbox();
  }, 2000);
}

main().catch((err) => {
  log('error', 'Channel plugin crashed', { error: err.message });
  process.exit(1);
});

#!/usr/bin/env node
/**
 * InkMail Plugin for Claude Code
 *
 * Pushes InkMail inbox messages and thread replies into a running Claude Code
 * session in real time via the Channels API (v2.1.80+).
 *
 * Features:
 * - Polls InkMail inbox for new unread messages
 * - Polls specific threads for new replies
 * - Pushes events as <channel source="pcp" ...> tags
 * - Exposes reply tool for two-way communication
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:inkmail
 *
 * Environment:
 *   INK_SERVER_URL  — Ink server URL (default: http://localhost:3001)
 *   INK_AGENT_ID    — Agent identity (default: from AGENT_ID or .ink/identity.json)
 *   INK_POLL_INTERVAL_MS — Poll interval in ms (default: 10000)
 *   INK_PLUGIN_LOG_LEVEL — debug | info | warn | error (default: info)
 *   INK_PLUGIN_LOG_MAX_BYTES — rotate the log past this size (default: 10485760)
 *   INK_PLUGIN_LOG_RETENTION_DAYS — sweep dead processes' logs older than this (default: 7)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createThreadDrainState, drainThreads, drainLegacyInbox } from './poll-core.js';
import { pendingTakeoverMarkerPath, processPendingTakeover } from './pending-takeover.js';
import { createLogger, isLogLevel, logFileFor, sweepStaleLogs, type LogLevel } from './logger.js';

// ─── Logging ────────────────────────────────────────────────
// Logs to ~/.ink/logs/channel-plugin/<pid>.log for debugging.
// Cannot use stdout (reserved for MCP stdio transport).
// Async + level-gated + size-capped — see logger.ts for why each matters.
//
// ONE FILE PER PROCESS, not one shared file. Every live Claude Code session
// runs a plugin, and a shared file put rotation on a concurrent path where it
// kept losing a generation to races. Per-process files make rotation
// single-writer again. Tail them together: ~/.ink/logs/channel-plugin/*.log
//
// Dead processes' logs are swept at startup so the directory stays bounded.

const LOG_DIR = join(homedir(), '.ink', 'logs', 'channel-plugin');
const LOG_FILE = join(LOG_DIR, logFileFor());

const configuredLevel = process.env.INK_PLUGIN_LOG_LEVEL;
const LOG_LEVEL: LogLevel = isLogLevel(configuredLevel) ? configuredLevel : 'info';
const LOG_MAX_BYTES = parseInt(process.env.INK_PLUGIN_LOG_MAX_BYTES || '10485760', 10);
const LOG_RETENTION_DAYS = parseInt(process.env.INK_PLUGIN_LOG_RETENTION_DAYS || '7', 10);

const logger = createLogger({
  dir: LOG_DIR,
  file: LOG_FILE,
  level: LOG_LEVEL,
  maxBytes: Number.isFinite(LOG_MAX_BYTES) && LOG_MAX_BYTES > 0 ? LOG_MAX_BYTES : undefined,
});

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  logger.log(level, message, data);
}

// ─── Config ─────────────────────────────────────────────────

const INK_SERVER_URL = process.env.INK_SERVER_URL || 'http://localhost:3001';
const POLL_INTERVAL_MS = parseInt(process.env.INK_POLL_INTERVAL_MS || '10000', 10);

function resolveAgentId(): string {
  if (process.env.INK_AGENT_ID) return process.env.INK_AGENT_ID;
  if (process.env.AGENT_ID) return process.env.AGENT_ID;

  // Try .ink/identity.json in cwd
  const identityPath = join(process.cwd(), '.ink', 'identity.json');
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
  const configPath = join(homedir(), '.ink', 'config.json');
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
  if (process.env.INK_ACCESS_TOKEN) return process.env.INK_ACCESS_TOKEN;

  // Try auth credentials
  const projectHash = Buffer.from(process.cwd()).toString('base64url').slice(0, 16);
  const credPaths = [
    join(homedir(), '.ink', 'auth', projectHash, 'credentials.json'),
    join(homedir(), '.ink', 'auth', 'default', 'credentials.json'),
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
const studioId = process.env.INK_STUDIO_ID || undefined;
const sessionId = process.env.INK_SESSION_ID || undefined;

/**
 * Check if a legacy inbox message is addressed to this studio.
 * Legacy messages (non-threaded) carry explicit recipient routing.
 *
 * Thread filtering is handled server-side via channelPoll=true on get_inbox.
 */
function isLegacyMessageForThisStudio(msg: Record<string, unknown>): boolean {
  if (!studioId) return true;

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
  server: INK_SERVER_URL,
  pollIntervalMs: POLL_INTERVAL_MS,
});

async function callPcp(
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const url = `${INK_SERVER_URL}/mcp`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  // Forward studio/session context so the server can apply channelPoll filtering
  if (studioId) {
    headers['x-ink-studio-id'] = studioId;
  }
  if (sessionId) {
    headers['x-ink-session-id'] = sessionId;
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
  { name: 'inkmail', version: '0.1.0' },
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
    instructions: `Messages from other SBs (AI agents) arrive as <channel source="inkmail" ...> tags.

These are real-time notifications from the Ink inbox — thread replies, task requests, review feedback, etc.

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

// Thread cursors, dedup, and cold-start skip accounting live in the drain
// state (poll-core.ts owns the delivery semantics; unit-tested there).
const drainState = createThreadDrainState();

// Durable turn-takeover recovery (PR #563 round 8): a failed interactive
// takeover on a non-blocking backend leaves a marker; this long-lived
// process converts it into a claim. See pending-takeover.ts.
const takeoverMarkerPath = pendingTakeoverMarkerPath(process.cwd());

async function claimPendingTakeover(
  markerAt: string | undefined
): Promise<'ok' | 'stopped' | 'failed'> {
  if (!sessionId || !accessToken) return 'failed';
  try {
    const resp = await fetch(`${INK_SERVER_URL}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      // reclaimOf CASes the claim against the server-side stop tombstone
      // (PR #563 round 9): a stop newer than the marker refuses atomically,
      // so a parked reclaim can never re-mark a finished turn as running.
      body: JSON.stringify({
        sessionId,
        lifecycle: 'running',
        event: 'prompt',
        ...(markerAt ? { reclaimOf: markerAt } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) return 'ok';
    if (resp.status === 409) return 'stopped';
    return 'failed';
  } catch {
    return 'failed';
  }
}
const seenMessageIds = drainState.seenMessageIds; // shared with the legacy loop

async function stampCliPollAt(): Promise<void> {
  if (!sessionId || !accessToken) return;
  try {
    await fetch(`${INK_SERVER_URL}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ sessionId, cliPollAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Non-fatal — next poll will try again
  }
}

// One-time fail-closed notice (spec inkmail-read-state §3): a plugin process
// with no session context gets nothing from channelPoll (server fail-closed).
// Surface that ONCE so a directly-launched session isn't silently featureless,
// then stay quiet — recurring warnings are noise.
let unscopedNoticeSent = false;

// In-flight guard (PR #385 pattern): during a slow/degraded server,
// interval ticks must SKIP rather than stack concurrent polls — every
// live Claude Code session runs one of these processes, so stacked
// polls multiply across the fleet. The interval and the one-shot
// startup poll are the only entry points (no forced path exists), so
// a plain boolean cannot be cleared early by an overlapping entrant.
let pollInFlight = false;

async function pollInbox(): Promise<void> {
  if (!email) return;
  if (pollInFlight) {
    log('debug', 'Poll skipped — previous poll still in flight');
    return;
  }
  pollInFlight = true;
  try {
    if (!sessionId && !unscopedNoticeSent) {
      unscopedNoticeSent = true;
      log('warn', 'No session context — InkMail delivery disabled (fail-closed), notifying once');
      await mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content:
              'InkMail delivery disabled for this session: no session context (INK_SESSION_ID). ' +
              'Launch via the ink wrapper for scoped delivery. Server log: channel_poll_unscoped.',
            meta: { sender: 'inkmail', message_type: 'notification' },
          },
        })
        .catch(() => {});
    }

    // Stamp cli_poll_at so the trigger handler knows we're alive
    stampCliPollAt().catch(() => {});

    // Convert any pending-takeover marker into a claim (fire-and-forget:
    // the marker survives a failed claim and is re-judged next tick).
    processPendingTakeover({
      markerPath: takeoverMarkerPath,
      sessionId,
      claim: claimPendingTakeover,
    })
      .then((outcome) => {
        if (outcome !== 'skipped') {
          log('info', `Pending turn takeover: ${outcome}`);
        }
      })
      .catch(() => {});

    try {
      // Pointer-based unseen fetch, NOT a wall-clock window (Lumen #504 r2
      // P1): `since` windows skipped startup backlog, and a truncated newest
      // page buried the unreturned oldest row forever. status:'unread' with
      // markRead:false serves the OLDEST unseen batch; only the exact-id ack
      // below advances delivery state, so truncation/ack failure simply
      // re-serves the same batch next poll.
      const result = await callPcp('get_inbox', {
        email,
        agentId,
        status: 'unread',
        markRead: false,
        limit: 20,
        channelPoll: true,
      });

      if (!result?.success) {
        log('error', 'Poll failed', { result: JSON.stringify(result).slice(0, 300) });
        return;
      }
      const threadCount = ((result.threadsWithUnread as unknown[]) || []).length;
      const msgCount = ((result.messages as unknown[]) || []).length;
      const totalUnread = (result.totalUnreadCount as number) || 0;
      log('debug', 'Poll result', { threadCount, msgCount, totalUnread });

      // Drain thread messages through poll-core (unit-tested): always-on
      // 100/poll budget with budget-bounded per-request limits, cold fetches
      // markRead:false + exact-id ack after injection, skip accounting with
      // one drain-time summary per process.
      const drained = await drainThreads(
        {
          callPcp,
          notify: async (content, meta) => {
            await mcp.notification({
              method: 'notifications/claude/channel',
              params: { content, meta },
            });
          },
          log,
          agentId,
          email,
          studioId,
        },
        drainState,
        (result.threadsWithUnread as Array<Record<string, unknown>>) || [],
        {
          moreThreadsPending: result.unreadThreadsTruncated === true,
          pollIncomplete: result.channelPollIncomplete === true,
        }
      );
      if (drained.injected > 0 || drained.ceilingHit || drained.fetchFailures > 0) {
        // 'info', not 'debug': this fires only on a real delivery (~tens per
        // day, not per-tick), and it is the line you actually want when
        // reconstructing what was delivered at the default log level.
        log('info', 'Thread drain result', { ...drained });
      }

      // Legacy inbox messages (non-threaded), drained through poll-core
      // (unit-tested) under the same exact-id ack contract as threads: the
      // mark_inbox_read throughMessageId ack after the batch is the ONLY
      // consumption, so what this caller injects is what gets consumed —
      // without it, the pointer never moves for this caller and delivered
      // task requests stay counted/re-delivered forever (Lumen #504 r1 P1).
      const classifyLegacy = (msg: Record<string, unknown>) => {
        // A row routed to ANOTHER studio must stop the ack range — the
        // pointer is (user, agent)-global (Lumen #504 r2 P1).
        if (!isLegacyMessageForThisStudio(msg)) return 'foreign' as const;
        // Own messages are skipped unless cross-studio (same as threads).
        if (msg.senderAgentId === agentId) {
          if (!studioId) return 'skip' as const;
          const msgPcp = (msg.metadata as Record<string, unknown>)?.pcp as
            | Record<string, unknown>
            | undefined;
          const msgSender = msgPcp?.sender as Record<string, unknown> | undefined;
          const msgStudioId = msgSender?.studioId as string | undefined;
          if (!msgStudioId || msgStudioId === studioId) return 'skip' as const;
        }
        return 'deliver' as const;
      };
      const legacyDeps = {
        callPcp,
        notify: async (content: string, meta: Record<string, unknown>) => {
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: { content, meta },
          });
        },
        log,
        agentId,
        email,
        studioId,
      };

      // Contiguity loop (Lumen #504 r2 P1): a truncated backlog drains batch
      // by batch — after a clean, fully-acked batch, fetch the next oldest
      // batch immediately. Any failure (emit, ack, foreign-studio stop)
      // holds; the next poll resumes from the pointer.
      let inboxMessages = (result.messages as Array<Record<string, unknown>>) || [];
      let legacyTruncated = result.truncated === true;
      for (let round = 0; round < 5; round++) {
        const legacyDrained = await drainLegacyInbox(
          legacyDeps,
          seenMessageIds,
          inboxMessages,
          classifyLegacy
        );
        if (legacyDrained.injected > 0 || legacyDrained.ackFailures > 0) {
          log('info', 'Legacy inbox drain result', { ...legacyDrained, round });
        }
        if (
          !legacyTruncated ||
          legacyDrained.emitFailures > 0 ||
          legacyDrained.ackFailures > 0 ||
          legacyDrained.stoppedAtForeignStudio
        ) {
          break;
        }
        const next = await callPcp('get_inbox', {
          email,
          agentId,
          status: 'unread',
          markRead: false,
          limit: 20,
          channelPoll: true,
        });
        if (!next?.success) break;
        inboxMessages = (next.messages as Array<Record<string, unknown>>) || [];
        legacyTruncated = next.truncated === true;
        if (!inboxMessages.length) break;
      }
    } catch (err) {
      log('error', 'Poll error', { error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    pollInFlight = false;
  }
}

// ─── Start ──────────────────────────────────────────────────

async function clearCliAttached(): Promise<void> {
  if (!sessionId || !accessToken) return;
  try {
    await fetch(`${INK_SERVER_URL}/api/hooks/lifecycle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ sessionId, cliAttached: false }),
      signal: AbortSignal.timeout(2000),
    });
    log('info', 'Detach: cleared cli_attached', { sessionId });
  } catch (err) {
    log('warn', 'Detach: failed to clear cli_attached', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  // Bound the log directory: drop dead processes' logs past the retention
  // window. Fire-and-forget — a sweep failure must never delay startup.
  const retentionDays =
    Number.isFinite(LOG_RETENTION_DAYS) && LOG_RETENTION_DAYS > 0 ? LOG_RETENTION_DAYS : 7;
  void sweepStaleLogs({ dir: LOG_DIR, maxAgeMs: retentionDays * 24 * 60 * 60 * 1000 })
    .then((removed) => {
      if (removed.length) log('info', 'Swept stale plugin logs', { count: removed.length });
    })
    .catch(() => {});

  log('info', 'Connecting MCP stdio transport');
  await mcp.connect(new StdioServerTransport());
  log('info', 'MCP connected, starting poll loop');

  // Fire detach cleanup when the host process exits (stdio pipe breaks).
  // This clears cli_attached so future triggers don't skip spawning.
  process.on('exit', () => {
    // Exit handlers run sync-only: an async stream write here would never
    // land. This is the one place logSync is correct.
    logger.logSync('info', 'Detach: process exiting, clearing cli_attached');
  });
  // Async logging means queued lines are still in flight at shutdown; flush
  // before exiting or we lose exactly the lines that explain the exit.
  const shutdown = (code: number) => {
    clearCliAttached().finally(() => logger.flush().finally(() => process.exit(code)));
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // Stdio close = Claude Code exited (most reliable signal)
  process.stdin.on('close', () => {
    log('info', 'Detach: stdin closed (host exited)');
    shutdown(0);
  });

  // Start polling loop
  setInterval(pollInbox, POLL_INTERVAL_MS);

  // Initial poll after a short delay (let MCP connection stabilize)
  setTimeout(async () => {
    await pollInbox();
  }, 2000);
}

main().catch((err) => {
  // Sync write: a crash line that loses the race with process.exit is worse
  // than useless — this is the one line you always want on disk.
  logger.logSync('error', 'Channel plugin crashed', { error: err.message });
  clearCliAttached().finally(() => logger.flush().finally(() => process.exit(1)));
});

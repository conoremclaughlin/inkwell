/**
 * ink wait — Poll for new inbox/thread messages and exit when something arrives.
 *
 * Designed to be run in the background so the SB wakes up when there's
 * new content to process. Works with Claude Code's run_in_background.
 *
 * Usage:
 *   ink wait                              # Wait for any new message
 *   ink wait --thread pr:231              # Wait for activity on a specific thread
 *   ink wait --timeout 300 --interval 15  # Custom timing
 */

import type { Command } from 'commander';
import { PcpClient } from '../lib/pcp-client.js';

interface WaitOptions {
  thread?: string;
  timeout?: string;
  interval?: string;
  agent?: string;
  pending?: boolean;
}

function resolveAgentId(): string {
  return process.env.AGENT_ID || 'wren';
}

export function registerWaitCommand(program: Command): void {
  program
    .command('wait')
    .description('Wait for new inbox or thread messages, then exit with the content')
    .option('-t, --thread <threadKey>', 'Watch a specific thread for new messages')
    .option('--timeout <seconds>', 'Max wait time in seconds (default: 300)', '300')
    .option('--interval <seconds>', 'Poll interval in seconds (default: 15)', '15')
    .option('-a, --agent <agentId>', 'Agent ID (default: from env)')
    .option('--pending', 'Also check pending message queue (for CLI-attached sessions)')
    .action(async (options: WaitOptions) => {
      const timeoutSec = Math.max(10, parseInt(options.timeout || '300', 10));
      const intervalSec = Math.max(5, parseInt(options.interval || '15', 10));
      const agentId = options.agent || resolveAgentId();
      const threadKey = options.thread;

      const pcp = new PcpClient();
      const config = pcp.getConfig();

      if (!config.email) {
        console.error('[ink wait] PCP not configured. Run: ink init');
        process.exit(2);
      }

      const deadline = Date.now() + timeoutSec * 1000;
      const startedAt = new Date().toISOString();

      console.log(
        `[ink wait] Watching ${threadKey ? `thread ${threadKey}` : 'inbox'} for ${agentId} (timeout: ${timeoutSec}s, interval: ${intervalSec}s)`
      );

      // ── Baseline anchors ──
      // Thread: anchor on the last message ID (not count — count from limited
      // results is unreliable). Use afterMessageId for subsequent polls.
      // Inbox: anchor on totalUnreadCount.
      let baselineLastMessageId: string | undefined;
      let baselineInboxCount = 0;

      if (threadKey) {
        try {
          // Fetch recent messages to find the latest message ID as anchor.
          // Known limitation: threads with >200 messages will anchor on #200,
          // not the true latest. Needs server-side "latest message" support
          // or descending order in get_thread_messages to fix properly.
          const threadResult = (await pcp.callTool('get_thread_messages', {
            email: config.email,
            agentId,
            threadKey,
            markRead: false,
            limit: 200,
          })) as Record<string, unknown>;
          const messages = (threadResult.messages as Array<Record<string, unknown>>) || [];
          if (messages.length > 0) {
            baselineLastMessageId = messages[messages.length - 1].id as string;
          }
          console.log(
            `[ink wait] Baseline: ${messages.length} messages in thread${baselineLastMessageId ? ` (anchor: ${(baselineLastMessageId as string).slice(0, 8)})` : ''}`
          );
        } catch {
          console.log('[ink wait] Baseline: thread not found (watching for creation)');
        }
      } else {
        try {
          const inboxResult = (await pcp.callTool('get_inbox', {
            email: config.email,
            agentId,
            status: 'unread',
            limit: 1,
          })) as Record<string, unknown>;
          baselineInboxCount =
            ((inboxResult.totalUnreadCount as number) ?? (inboxResult.unreadCount as number)) || 0;
        } catch {
          // Baseline is 0
        }
        console.log(`[ink wait] Baseline: ${baselineInboxCount} unread`);
      }

      // Exponential backoff on consecutive poll errors. This stops `ink wait`
      // from hammering the server when it's brownouting (the 2026-04-19
      // incident: background waits retried every 15s through a 503 storm
      // and helped fill Docker's disk with Kong error logs).
      let consecutiveErrors = 0;
      const maxBackoffSec = Math.max(intervalSec, 120); // cap the pause at ~2 min

      while (Date.now() < deadline) {
        const sleepMs =
          consecutiveErrors === 0
            ? intervalSec * 1000
            : Math.min(
                maxBackoffSec * 1000,
                intervalSec * 1000 * 2 ** Math.min(consecutiveErrors, 6)
              ) *
              (0.5 + Math.random() * 0.5); // 50–100% jitter

        await new Promise((resolve) => setTimeout(resolve, sleepMs));

        try {
          // Check pending queue only when --pending is explicitly passed
          if (options.pending) {
            const pendingResult = (await pcp.callTool('get_pending_messages', {
              channel: 'agent',
              limit: 5,
              since: startedAt,
            })) as Record<string, unknown>;
            const pendingMessages = pendingResult.messages as
              | Array<Record<string, unknown>>
              | undefined;
            // Filter to messages created after we started waiting
            const newPending = (pendingMessages || []).filter((m) => {
              const ts = m.timestamp as string | undefined;
              return !ts || ts >= startedAt;
            });
            if (newPending.length) {
              console.log(`[ink wait] ${newPending.length} pending trigger message(s) found`);
              for (const msg of newPending) {
                const sender =
                  typeof msg.sender === 'object'
                    ? (msg.sender as Record<string, unknown>).id || 'unknown'
                    : msg.sender || 'unknown';
                const preview = typeof msg.content === 'string' ? msg.content.slice(0, 200) : '';
                console.log(`  from ${sender}: ${preview}`);
              }
              // Mark as read so next ink wait doesn't re-trigger on them
              const ids = newPending.map((m) => m.id as string).filter(Boolean);
              if (ids.length) {
                await pcp.callTool('mark_messages_read', { messageIds: ids }).catch(() => {});
              }
              process.exit(0);
            }
          }

          if (threadKey) {
            // Watch specific thread — use afterMessageId to only get NEW messages
            const pollArgs: Record<string, unknown> = {
              email: config.email,
              agentId,
              threadKey,
              markRead: false,
              limit: 10,
            };
            if (baselineLastMessageId) {
              pollArgs.afterMessageId = baselineLastMessageId;
            }

            const threadResult = (await pcp.callTool('get_thread_messages', pollArgs)) as Record<
              string,
              unknown
            >;

            const allMessages = (threadResult.messages as Array<Record<string, unknown>>) || [];
            // Filter out own messages — we're waiting for someone ELSE to reply
            const messages = allMessages.filter((m) => m.senderAgentId !== agentId);
            if (messages.length > 0) {
              console.log(`[ink wait] ${messages.length} new message(s) on ${threadKey}`);
              for (const msg of messages) {
                const sender = msg.senderAgentId || 'unknown';
                const preview = typeof msg.content === 'string' ? msg.content.slice(0, 200) : '';
                console.log(`  from ${sender}: ${preview}`);
              }
              process.exit(0);
            }
          } else {
            // Watch inbox for any new unread
            const inboxResult = (await pcp.callTool('get_inbox', {
              email: config.email,
              agentId,
              status: 'unread',
              limit: 5,
            })) as Record<string, unknown>;

            const currentUnread =
              ((inboxResult.totalUnreadCount as number) ?? (inboxResult.unreadCount as number)) ||
              0;

            if (currentUnread > baselineInboxCount) {
              const messages = inboxResult.messages as Array<Record<string, unknown>> | undefined;
              const threads = inboxResult.threadsWithUnread as
                | Array<Record<string, unknown>>
                | undefined;

              console.log(`[ink wait] ${currentUnread - baselineInboxCount} new unread message(s)`);

              if (messages?.length) {
                for (const msg of messages.slice(0, 3)) {
                  const sender = msg.senderAgentId || 'unknown';
                  const preview = typeof msg.content === 'string' ? msg.content.slice(0, 150) : '';
                  console.log(`  inbox: from ${sender}: ${preview}`);
                }
              }

              if (threads?.length) {
                for (const t of threads.slice(0, 3)) {
                  console.log(`  thread ${t.threadKey}: ${t.unreadCount} unread`);
                }
              }

              process.exit(0);
            }
          }

          // Successful poll — reset backoff.
          consecutiveErrors = 0;
          console.log('[ink wait] No new messages yet...');
        } catch (error) {
          consecutiveErrors += 1;
          const msg = error instanceof Error ? error.message : String(error);
          const nextBackoffSec = Math.min(
            maxBackoffSec,
            intervalSec * 2 ** Math.min(consecutiveErrors, 6)
          );
          console.log(
            `[ink wait] Poll error #${consecutiveErrors} (next retry in ~${nextBackoffSec}s): ${msg.slice(0, 100)}`
          );
        }
      }

      console.error(`[ink wait] Timed out after ${timeoutSec}s with no new messages.`);
      process.exit(1);
    });
}

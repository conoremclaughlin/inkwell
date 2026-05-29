/**
 * ink wait — Poll for new inbox/thread messages and exit when something arrives.
 *
 * Designed to be run in the background so the SB wakes up when there's
 * new content to process. Works with Claude Code's run_in_background.
 *
 * Usage:
 *   ink wait                              # Wait for any new message
 *   ink wait --thread pr:231              # Wait for activity on a specific thread
 *   ink wait --group <uuid>               # Watch autonomous strategy progress
 *   ink wait --timeout 300 --interval 15  # Custom timing
 */

import type { Command } from 'commander';
import { PcpClient } from '../lib/pcp-client.js';

interface WaitOptions {
  thread?: string;
  group?: string;
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
    .option('-g, --group <groupId>', 'Watch an autonomous strategy/task group for progress')
    .option('--timeout <seconds>', 'Max wait time in seconds (default: 300)', '300')
    .option('--interval <seconds>', 'Poll interval in seconds (default: 15)', '15')
    .option('-a, --agent <agentId>', 'Agent ID (default: from env)')
    .option('--pending', 'Also check pending message queue (for CLI-attached sessions)')
    .action(async (options: WaitOptions) => {
      const timeoutSec = Math.max(10, parseInt(options.timeout || '300', 10));
      const intervalSec = Math.max(5, parseInt(options.interval || '15', 10));
      const agentId = options.agent || resolveAgentId();
      const threadKey = options.thread;
      const groupId = options.group;

      const pcp = new PcpClient();
      const config = pcp.getConfig();

      if (!config.email) {
        console.error('[ink wait] PCP not configured. Run: ink init');
        process.exit(2);
      }

      // ── Strategy/task group watch mode ──
      if (groupId) {
        await watchStrategy(pcp, groupId, timeoutSec, intervalSec);
        return;
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

interface StrategyStatus {
  title?: string;
  strategy?: string;
  status?: string;
  progress?: {
    total?: number;
    completed?: number;
    pending?: number;
    inProgress?: number;
    blocked?: number;
    completionRate?: number;
  };
  currentTask?: {
    id?: string;
    title?: string;
    status?: string;
    taskOrder?: number;
  };
  summary?: string;
  config?: {
    supervisorId?: string;
    approvalNotify?: string;
    studioSlug?: string;
    [key: string]: unknown;
  };
}

async function watchStrategy(
  pcp: PcpClient,
  groupId: string,
  timeoutSec: number,
  intervalSec: number
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let consecutiveErrors = 0;
  const maxBackoffSec = Math.max(intervalSec, 120);

  // Fetch initial state
  let lastCompleted = 0;
  let lastTaskId: string | undefined;
  let lastStatus: string | undefined;

  try {
    const initial = (await pcp.callTool('get_strategy_status', {
      groupId,
    })) as StrategyStatus;
    lastCompleted = initial.progress?.completed ?? 0;
    lastTaskId = initial.currentTask?.id;
    lastStatus = initial.status;

    const total = initial.progress?.total ?? 0;
    console.log(`[ink wait] Watching strategy: ${initial.title || groupId}`);
    console.log(
      `[ink wait] Strategy: ${initial.strategy || 'unknown'} | Status: ${initial.status || 'unknown'} | Progress: ${lastCompleted}/${total}`
    );
    if (initial.currentTask) {
      console.log(
        `[ink wait] Current task: "${initial.currentTask.title}" (${initial.currentTask.status})`
      );
    }
    if (initial.config?.approvalNotify) {
      console.log(`[ink wait] Architect reviewer: ${initial.config.approvalNotify}`);
    }
    if (initial.config?.studioSlug) {
      console.log(`[ink wait] Studio: ${initial.config.studioSlug}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[ink wait] Failed to fetch initial strategy status: ${msg}`);
    process.exit(2);
  }

  while (Date.now() < deadline) {
    const sleepMs =
      consecutiveErrors === 0
        ? intervalSec * 1000
        : Math.min(maxBackoffSec * 1000, intervalSec * 1000 * 2 ** Math.min(consecutiveErrors, 6)) *
          (0.5 + Math.random() * 0.5);

    await new Promise((resolve) => setTimeout(resolve, sleepMs));

    try {
      const status = (await pcp.callTool('get_strategy_status', {
        groupId,
      })) as StrategyStatus;

      consecutiveErrors = 0;

      const completed = status.progress?.completed ?? 0;
      const total = status.progress?.total ?? 0;
      const blocked = status.progress?.blocked ?? 0;
      const currentTaskId = status.currentTask?.id;
      const strategyStatus = status.status;

      // Strategy completed or cancelled — exit with summary
      if (strategyStatus === 'completed' || strategyStatus === 'cancelled') {
        console.log(`\n[ink wait] Strategy ${strategyStatus}: ${completed}/${total} tasks done`);
        if (status.summary) {
          console.log(`[ink wait] ${status.summary}`);
        }
        process.exit(strategyStatus === 'completed' ? 0 : 1);
      }

      // Strategy paused (e.g., awaiting approval)
      if (strategyStatus === 'paused' && lastStatus !== 'paused') {
        console.log(
          `\n[ink wait] Strategy paused — may be awaiting approval (${completed}/${total} done)`
        );
        if (status.currentTask) {
          console.log(
            `[ink wait] Last task: "${status.currentTask.title}" (${status.currentTask.status})`
          );
        }
        lastStatus = strategyStatus;
        continue;
      }

      // Task advanced — a task was completed since last check
      if (completed > lastCompleted) {
        const delta = completed - lastCompleted;
        console.log(
          `\n[ink wait] ${delta} task(s) completed! Progress: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`
        );
        if (status.currentTask) {
          console.log(
            `[ink wait] Now working on: "${status.currentTask.title}" (${status.currentTask.status})`
          );
        }
        lastCompleted = completed;
        lastTaskId = currentTaskId;
        lastStatus = strategyStatus;
        continue;
      }

      // Current task changed (e.g., moved from pending to in_progress)
      if (currentTaskId && currentTaskId !== lastTaskId) {
        console.log(
          `[ink wait] Task changed: "${status.currentTask?.title}" (${status.currentTask?.status})`
        );
        lastTaskId = currentTaskId;
        lastStatus = strategyStatus;
        continue;
      }

      // Blocked tasks appeared
      if (blocked > 0) {
        console.log(`[ink wait] ${blocked} task(s) blocked — ${completed}/${total} done`);
        lastStatus = strategyStatus;
        continue;
      }

      // No change
      const taskLabel = status.currentTask ? `working on: "${status.currentTask.title}"` : 'idle';
      console.log(`[ink wait] ${completed}/${total} done — ${taskLabel}`);
      lastStatus = strategyStatus;
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

  console.error(`[ink wait] Timed out after ${timeoutSec}s. Strategy still running.`);
  process.exit(1);
}

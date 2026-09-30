/**
 * ink wait — Poll for new inbox/thread messages and exit when something arrives,
 * or keep watching with --follow.
 *
 * Designed to be run in the background so the SB wakes up when there's
 * new content to process. Works with Claude Code's run_in_background; the
 * --follow form suits a stream consumer (Claude Code's Monitor), which turns
 * each stdout line into an event.
 *
 * Usage:
 *   ink wait                              # Wait for any new message
 *   ink wait --thread pr:231              # Wait for activity on a specific thread
 *   ink wait --thread pr:231 --follow     # Report every batch until cancelled
 *   ink wait --group <uuid>               # Watch autonomous strategy progress
 *   ink wait --timeout 300 --interval 15  # Custom timing
 */

import type { Command } from 'commander';
import { InkClient } from '../lib/ink-client.js';
import { NOT_SIGNED_IN_MESSAGE } from '../lib/user-config.js';
import { watchMessages, type WaitClock, type WaitOutput } from './wait-watch.js';

interface WaitOptions {
  thread?: string;
  group?: string;
  timeout?: string;
  interval?: string;
  agent?: string;
  pending?: boolean;
  follow?: boolean;
}

function resolveSlug(): string {
  return process.env.SB_SLUG || process.env.AGENT_ID || 'wren';
}

/** Whole seconds from a flag value, or undefined when it is not a number. */
function parseSeconds(value: string): number | undefined {
  const seconds = parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: abortableDelay,
  // Real timers already run alongside each other.
  timer: abortableDelay,
  random: () => Math.random(),
};

function waitOutput(follow: boolean): WaitOutput {
  // Follow mode keeps stdout for batches alone, so every stdout line is an event.
  const statusStream = follow ? process.stderr : process.stdout;
  return {
    batch: (lines) => process.stdout.write(`${lines.join('\n')}\n`),
    status: (line) => statusStream.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}

export function registerWaitCommand(program: Command): void {
  program
    .command('wait')
    .description('Wait for new inbox or thread messages, then exit with the content')
    .option('-t, --thread <threadKey>', 'Watch a specific thread for new messages')
    .option('-g, --group <groupId>', 'Watch an autonomous strategy/task group for progress')
    .option(
      '-f, --follow',
      'Keep watching after the first batch and print each new batch as it arrives, ' +
        'until Ctrl-C/SIGTERM or --timeout. Only batches go to stdout; status goes to stderr'
    )
    .option(
      '--timeout <seconds>',
      'Max wait time in seconds (default: 300; with --follow: no limit unless given)'
    )
    .option('--interval <seconds>', 'Poll interval in seconds (default: 15)', '15')
    .option('-a, --agent <sbSlug>', 'SB slug (default: from env)')
    .option('--pending', 'Also check pending message queue (for CLI-attached sessions)')
    .action(async (options: WaitOptions) => {
      const follow = Boolean(options.follow);
      const interval = parseSeconds(options.interval || '15');
      const timeout = options.timeout === undefined ? undefined : parseSeconds(options.timeout);
      if (interval === undefined || (options.timeout !== undefined && timeout === undefined)) {
        const flag = interval === undefined ? '--interval' : '--timeout';
        console.error(`[ink wait] ${flag} must be a number of seconds.`);
        process.exit(2);
      }
      if (follow && options.group) {
        // The strategy watch already reports each change until the strategy
        // ends, and prints progress to stdout on every poll, which breaks
        // follow mode's promise that stdout carries only events.
        console.error(
          '[ink wait] --follow does not apply to --group: the strategy watch already reports ' +
            'each change until the strategy ends. Use --timeout to watch it for longer.'
        );
        process.exit(2);
      }
      const intervalSec = Math.max(5, interval);
      // One-shot keeps its 300s default. Follow runs until cancelled unless a
      // deadline was asked for.
      const timeoutSec = timeout !== undefined ? Math.max(10, timeout) : follow ? undefined : 300;
      const sbSlug = options.agent || resolveSlug();

      const inkClient = new InkClient();
      const config = inkClient.getConfig();

      if (!config.email) {
        console.error(`[ink wait] ${NOT_SIGNED_IN_MESSAGE}`);
        process.exit(2);
      }

      // ── Strategy/task group watch mode ──
      if (options.group) {
        await watchStrategy(inkClient, options.group, timeoutSec ?? 300, intervalSec);
        return;
      }

      const controller = new AbortController();
      if (follow) {
        // once: a second Ctrl-C falls through to the default and kills outright.
        process.once('SIGINT', () => controller.abort('SIGINT'));
        process.once('SIGTERM', () => controller.abort('SIGTERM'));
      }

      const code = await watchMessages(
        {
          email: config.email,
          sbSlug,
          threadKey: options.thread,
          pending: Boolean(options.pending),
          follow,
          timeoutSec,
          intervalSec,
        },
        {
          call: (tool, args) => inkClient.callTool(tool, args),
          clock: realClock,
          output: waitOutput(follow),
          signal: controller.signal,
        }
      );
      process.exit(code);
    });
}

interface StrategyStatus {
  success?: boolean;
  error?: string;
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

export function validateStrategyResult(result: Record<string, unknown>, context: string): void {
  if (result.success === false) {
    throw new Error((result.error as string) || `${context}: server returned failure`);
  }
  // callTool returns { text: "MCP error ..." } for non-JSON MCP errors (e.g., schema validation)
  if (typeof result.text === 'string' && !result.status && !result.progress) {
    throw new Error(result.text as string);
  }
}

async function watchStrategy(
  inkClient: InkClient,
  groupId: string,
  timeoutSec: number,
  intervalSec: number
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let consecutiveErrors = 0;
  const maxBackoffSec = Math.max(intervalSec, 120);
  const config = inkClient.getConfig();

  // Fetch initial state
  let lastCompleted = 0;
  let lastTaskId: string | undefined;
  let lastStatus: string | undefined;

  try {
    const initialRaw = await inkClient.callTool('get_strategy_status', {
      groupId,
      email: config.email,
    });
    validateStrategyResult(initialRaw, 'Initial fetch');
    const initial = initialRaw as unknown as StrategyStatus;
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
      const statusRaw = await inkClient.callTool('get_strategy_status', {
        groupId,
        email: config.email,
      });
      validateStrategyResult(statusRaw, 'Poll');
      const status = statusRaw as unknown as StrategyStatus;

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

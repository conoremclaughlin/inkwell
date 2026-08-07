/**
 * ink observe — attach read-only to a live session's canonical event stream.
 *
 * The acceptance demo of spec:observer-attach: N terminals, one writer,
 * identical views. Consumes GET /api/sessions/:id/events?channel=obs — the
 * server-brokered SSE stream of canonical ledger entries (SSE frame id =
 * ledger eid). Detaching never affects the session.
 *
 * Convergence: the client tracks the last processed eid; on overflow
 * disconnect (`event: end`, reason overflow) or a dropped connection it
 * reconnects with an exclusive afterEid cursor, and the server's durable
 * replay closes the gap — the rendered sequence can never silently diverge
 * from the ledger.
 *
 * Usage:
 *   ink observe <sessionId>                # replay recent, then follow live
 *   ink observe <sessionId> --from-start   # full-history replay, then follow
 *   ink observe <sessionId> --no-follow    # replay and exit
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { PcpClient } from '../lib/pcp-client.js';
import { getValidAccessToken } from '../auth/tokens.js';

export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed decoded text chunks; complete frames
 * (terminated by a blank line) are returned as they finish. Comment lines
 * (": ping") are dropped per the SSE spec.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const frames: SseFrame[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) >= 0) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const frame: SseFrame = { event: 'message', data: '' };
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const field = line.slice(0, colon);
        const value = line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') frame.event = value;
        else if (field === 'data') dataLines.push(value);
        else if (field === 'id') frame.id = value;
      }
      frame.data = dataLines.join('\n');
      if (frame.event !== 'message' || frame.data) frames.push(frame);
    }
    return frames;
  }
}

const truncate = (value: unknown, max = 160): string => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

/**
 * One rendered line per canonical entry — the observer projection in the
 * chat feed's visual language. Pure (returns the string) for testability.
 */
export function renderObserverEntry(entry: Record<string, unknown>): string {
  const eid = chalk.dim(`#${entry.eid ?? '?'}`);
  switch (entry.type) {
    case 'backend_tool': {
      const name = entry.name ? ` ${chalk.cyan(String(entry.name))}` : '';
      const status = String(entry.status ?? '');
      const badge =
        status === 'running'
          ? chalk.yellow('▶')
          : status === 'error'
            ? chalk.red('✗')
            : chalk.green('✓');
      return `${eid} ${badge} tool${name} ${chalk.dim(status)}`;
    }
    case 'backend_text':
      return `${eid} ${chalk.dim('…')} ${chalk.dim(truncate(entry.preview))}`;
    case 'user':
      return `${eid} ${chalk.bold.blue('user')} ${truncate(entry.content)}`;
    case 'system_turn':
      return `${eid} ${chalk.magenta(`system${entry.label ? `:${entry.label}` : ''}`)} ${chalk.dim(
        truncate(entry.content)
      )}`;
    case 'auto_turn':
      return `${eid} ${chalk.magenta('auto')} ${chalk.dim(truncate(entry.content))}`;
    case 'assistant':
      return `${eid} ${chalk.bold.green('assistant')} ${truncate(entry.content, 400)}`;
    case 'inbox':
      // Frames carry the projected preview (never raw payloads/tokens).
      return `${eid} ${chalk.yellow('inbox')}${entry.sender ? ` ${chalk.dim(String(entry.sender))}` : ''} ${chalk.dim(truncate(entry.preview ?? entry.content))}`;
    case 'local_tool_call':
    case 'pcp_tool': {
      const status = String(entry.status ?? '');
      const badge =
        status === 'error'
          ? chalk.red('✗')
          : status === 'running'
            ? chalk.yellow('▶')
            : chalk.green('✓');
      return `${eid} ${badge} ${chalk.cyan(String(entry.tool ?? 'tool'))} ${chalk.dim(status)}`;
    }
    case 'backend_session':
      return `${eid} ${chalk.dim(`backend session → ${truncate(entry.id, 40)}`)}`;
    case 'compaction':
      return `${eid} ${chalk.yellow('⛁ compaction')} ${chalk.dim(truncate(entry.reason ?? ''))}`;
    case 'session_pause':
    case 'session_end':
      return `${eid} ${chalk.dim(`— ${String(entry.type).replace('session_', 'session ')} —`)}`;
    default:
      return `${eid} ${chalk.dim(String(entry.type))} ${chalk.dim(truncate(JSON.stringify(entry), 120))}`;
  }
}

interface ObserveOptions {
  fromStart?: boolean;
  follow?: boolean;
  server?: string;
}

const RECONNECT_DELAY_MS = 750;

export function registerObserveCommand(program: Command): void {
  program
    .command('observe <sessionId>')
    .description('Attach read-only to a live session (replay recent, then follow)')
    .option('--from-start', 'Replay the full session history from the ledger first')
    .option('--no-follow', 'Replay only, then exit')
    .option('--server <url>', 'Server URL (default: INK_SERVER_URL or http://localhost:3001)')
    .action(async (sessionId: string, options: ObserveOptions) => {
      const pcp = new PcpClient(options.server);
      const baseUrl = pcp.getBaseUrl();
      const token = await getValidAccessToken(baseUrl);
      if (!token) {
        console.error(
          chalk.red(
            `Not authenticated with ${baseUrl}. Run: INK_SERVER_URL=${baseUrl} ink auth login`
          )
        );
        process.exitCode = 1;
        return;
      }

      let lastEid: number | undefined = options.fromStart ? 0 : undefined;
      let sawEntry = false;
      let stopped = false;
      process.on('SIGINT', () => {
        stopped = true;
        console.log(chalk.dim('\ndetached — the session neither knows nor cares.'));
        process.exit(0);
      });

      console.log(chalk.dim(`observing ${sessionId} @ ${baseUrl} (ctrl+c to detach)`));

      // Idle notice (Myra): a quiet session must look idle, not broken.
      const idleTimer = setTimeout(() => {
        if (!sawEntry) {
          void pcp
            .callTool('get_session', { sessionId })
            .then((s) => {
              const session = (s as { session?: Record<string, unknown> }).session;
              const phase = session?.currentPhase ?? session?.current_phase ?? 'unknown';
              const updated = session?.updatedAt ?? session?.updated_at;
              console.log(
                chalk.dim(
                  `session idle — phase ${String(phase)}${updated ? `, last activity ${String(updated)}` : ''}. Live events will appear here.`
                )
              );
            })
            .catch(() => {
              console.log(chalk.dim('session idle — live events will appear here.'));
            });
        }
      }, 3_000);
      idleTimer.unref?.();

      while (!stopped) {
        const params = new URLSearchParams({ channel: 'obs' });
        if (lastEid !== undefined) params.set('afterEid', String(lastEid));
        if (options.follow === false) params.set('follow', 'false');

        let response: Response;
        try {
          response = await fetch(`${baseUrl}/api/sessions/${sessionId}/events?${params}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (err) {
          console.error(chalk.red(`connection failed: ${String(err)}`));
          await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
          continue;
        }

        if (response.status === 403) {
          console.error(chalk.red('403 — you are not authorized to observe this session.'));
          process.exitCode = 1;
          return;
        }
        if (!response.ok || !response.body) {
          console.error(chalk.red(`server returned ${response.status}`));
          process.exitCode = 1;
          return;
        }

        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let endedByServer = false;

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
              if (frame.event === 'connected') continue;
              if (frame.event === 'end') {
                endedByServer = true;
                let reason = 'closed';
                try {
                  reason = (JSON.parse(frame.data) as { reason?: string }).reason ?? reason;
                } catch {
                  // keep default
                }
                if (reason === 'overflow') {
                  console.log(
                    chalk.yellow('⚠ fell behind — reconnecting from last processed entry')
                  );
                } else {
                  console.log(chalk.dim(`stream ended (${reason})`));
                  return;
                }
                break;
              }
              // Canonical entry frame.
              try {
                const entry = JSON.parse(frame.data) as Record<string, unknown>;
                sawEntry = true;
                if (frame.id) lastEid = Number.parseInt(frame.id, 10);
                console.log(renderObserverEntry(entry));
              } catch {
                // Not JSON — ignore.
              }
            }
            if (endedByServer) break;
          }
        } catch {
          // Network drop — fall through to reconnect.
        }

        if (options.follow === false) return; // replay-only: single pass
        if (!endedByServer) {
          console.log(chalk.dim('connection dropped — reconnecting'));
        }
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      }
    });
}

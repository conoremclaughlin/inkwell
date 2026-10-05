import type { EventEmitter } from 'events';

// Names the signal and what usually sends it. It does not claim the terminal
// closed: an explicit `kill -HUP` arrives the same way and logs the same line.
export const HANGUP_REASON = 'SIGHUP (hangup, the signal a closing terminal sends)';

/**
 * Turn a SIGHUP into the server's graceful shutdown.
 *
 * SIGHUP is what a terminal sends the jobs running in it when it closes, and
 * the main server runs in one. Node's default for the signal is to exit on the
 * spot, so on 2026-09-30, when an overnight OS update quit that terminal at
 * 04:27, the server died without logging a line or recording the agent runs it
 * interrupted. The log simply stopped, and it took the system log to say why.
 *
 * By the time this runs the terminal is gone, and the next console write fails
 * (EIO on a closed terminal, EPIPE on a closed pipe). Nothing listens for that
 * error, so it becomes an uncaught exception, and winston's exception handler
 * answers one by exiting the process: the shutdown started here would be cut
 * off by its own first log line. A listener on each console stream takes the
 * error instead. The file transports, the record that matters now, are
 * untouched.
 */
export function handleHangup(
  shutdown: (reason: string) => unknown,
  consoleStreams: EventEmitter[] = [process.stdout, process.stderr]
): void {
  for (const stream of consoleStreams) {
    stream.on('error', ignoreClosedConsoleError);
  }
  void shutdown(HANGUP_REASON);
}

function ignoreClosedConsoleError(): void {
  // The terminal this would have reported to no longer exists.
}

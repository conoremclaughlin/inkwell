import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { probeGroup, stopProcessAndWait } from '../sessions/stop-process.js';
import { LIMITS } from './config.js';
import { staticError, WebSearchError, type WebSearchReason } from './errors.js';

export interface BoundedProcessInput {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  signal?: AbortSignal;
  timeoutMs: number;
  stdoutBytes?: number;
  onLine?: (line: string) => void;
}

/**
 * No shell, no logging, no raw stderr retained. Close (not the result event)
 * gates success. Stop escalation and group-empty verification reuse the shared
 * process-only helper, not the session runner/credentials/launch database.
 */
export async function runBounded(input: BoundedProcessInput): Promise<string> {
  if (input.signal?.aborted) throw new WebSearchError('cancelled');
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      reject(new WebSearchError('spawn_failed'));
      return;
    }
    let done = false;
    let stopping = false;
    let failure: WebSearchError | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let output = '';
    let pending = '';
    const decoder = new StringDecoder('utf8');
    const settle = (error?: WebSearchError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      // These streams belong solely to this run; dropping them also bounds a
      // misbehaving transport after an unconfirmed physical stop.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.stdin?.destroy();
      if (error) reject(error);
      else resolve(output);
    };
    const stop = () => {
      if (stopping || done) return;
      stopping = true;
      void stopProcessAndWait(proc, {
        group: true,
        graceMs: LIMITS.stopGraceMs,
        giveUpMs: LIMITS.stopGiveUpMs,
      }).then(
        (outcome) => {
          settle(
            outcome.exited && outcome.group === 'empty'
              ? failure
              : new WebSearchError('stop_unconfirmed')
          );
        },
        () => settle(new WebSearchError('stop_unconfirmed'))
      );
    };
    const fail = (reason: WebSearchReason | WebSearchError) => {
      if (done || failure) return;
      failure = typeof reason === 'string' ? new WebSearchError(reason) : reason;
      // Failed spawn emits error without a pid: there is nothing to signal.
      if (proc.pid === undefined) settle(failure);
      else stop();
    };
    const onAbort = () => fail('cancelled');
    const timer = setTimeout(() => fail('timeout'), input.timeoutMs);
    const consume = (text: string, final = false) => {
      if (!input.onLine) {
        output += text;
        return;
      }
      pending += text;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > LIMITS.lineBytes) throw new WebSearchError('output_limit');
        if (line.trim()) input.onLine(line);
      }
      if (Buffer.byteLength(pending) > LIMITS.lineBytes) throw new WebSearchError('output_limit');
      if (final && pending.trim()) input.onLine(pending);
    };
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (done || failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > (input.stdoutBytes ?? LIMITS.stdoutBytes)) {
        fail('output_limit');
        return;
      }
      try {
        consume(decoder.write(chunk));
      } catch (error) {
        fail(staticError(error));
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > LIMITS.stderrBytes) fail('output_limit');
    });
    proc.once('error', () => fail('spawn_failed'));
    proc.stdout?.on('error', () => fail('provider_failed'));
    proc.stderr?.on('error', () => fail('provider_failed'));
    proc.stdin?.on('error', () => fail('provider_failed'));
    proc.once('close', (code, signal) => {
      if (done || stopping) return;
      if (code !== 0 || signal !== null) failure ??= new WebSearchError('provider_failed');
      if (!failure) {
        try {
          consume(decoder.end(), true);
        } catch (error) {
          failure = staticError(error);
        }
      }
      // A leader can exit while a descendant holds its group. Never equate
      // `killed` or a successful result line with an empty process group.
      if (proc.pid !== undefined && probeGroup(proc.pid) !== 'empty') stop();
      else settle(failure);
    });
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    try {
      proc.stdin?.end(input.stdin);
    } catch {
      fail('provider_failed');
    }
  });
}

import type { BackendRunRequest, BackendRunResult, BackendTurnHandle } from './backend-runner.js';
import type { BackendTurnEvent } from './stream.js';
import type { createSessionToolStream } from '../runtime/session-tool-stream.js';
import type { StreamDispatchResult } from '../runtime/stream-tool-dispatch.js';
import { ToolStreamSource } from './tool-stream-source.js';

type SessionToolStream = Pick<
  NonNullable<Awaited<ReturnType<typeof createSessionToolStream>>>,
  'append' | 'finish' | 'signal' | 'markGenerationEnded'
>;
export interface ProviderToolStreamPorts {
  /** Reserve a fresh durable attempt before the provider can emit anything. */
  open(signal: AbortSignal): Promise<SessionToolStream>;
  /** A headless host must route this through its alert path, not only its log. */
  reportFailure(message: string): void | Promise<void>;
}
export type ToolStreamingBackendResult = BackendRunResult & { toolStream?: StreamDispatchResult };

/**
 * One actual provider launch, not one logical loop iteration. The stream owns
 * dispatch; the final snapshot can only confirm that named source, never extend
 * or replay it. Still opt-in: production hosts must supply bounded execution/teardown
 * before enabling this composition.
 */
export async function runToolStreamingAttempt(options: {
  request: BackendRunRequest;
  startTurn(request: BackendRunRequest): BackendTurnHandle;
  onAbortHandle(abort: () => void): void;
  ports: ProviderToolStreamPorts;
  signal?: AbortSignal;
}): Promise<ToolStreamingBackendResult> {
  const controller = new AbortController();
  let turn: BackendTurnHandle | undefined;
  let launchEntered = false;
  let abortSent = false;
  let stream: SessionToolStream | undefined;
  let closing: ReturnType<SessionToolStream['finish']> | undefined;
  let failure: string | undefined;
  const source = new ToolStreamSource();
  const close = (endOfResponse: boolean) => {
    if (!closing && stream) {
      closing = stream.finish({ endOfResponse });
      // Observe immediately when Stop closes the source before the provider's
      // result has settled. The owner still awaits the original promise.
      void closing.catch(() => {});
    }
    return closing;
  };
  const stopProvider = () => {
    if (!turn || abortSent) return;
    abortSent = true;
    try {
      turn.abort();
    } catch {
      failure ??= 'Provider abort could not be confirmed.';
    }
  };
  const abort = () => {
    controller.abort();
    close(false);
    stopProvider();
  };
  const refuse = (message: string) => {
    failure ??= message;
    abort();
  };
  const onEvent = (event: BackendTurnEvent) => {
    // Do not let a reporting callback throw out of a child's stdout handler.
    // Close admission, retain the prefix, and reap via the existing abort port.
    try {
      if (!controller.signal.aborted && !closing) {
        try {
          const suffix = source.consume(event);
          if (suffix) stream!.append(suffix);
        } catch (error) {
          refuse(`Provider source refused; no further tools admitted: ${String(error)}`);
        }
      }
      // Display/usage receives the original event, including conflicting text.
      options.request.onEvent?.(event);
    } catch (error) {
      refuse(`Provider stream callback failed: ${String(error)}`);
    }
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  let result: BackendRunResult;
  try {
    options.signal?.throwIfAborted();
    try {
      stream = await options.ports.open(controller.signal);
    } catch (error) {
      await options.ports.reportFailure(
        `Tool ownership journal could not open; turn stopped without batch fallback: ${String(error)}`
      );
      throw error;
    }
    // An abort while the attempt's opening write was flushing still owns the
    // newly created source. Close it without ever launching a provider.
    stream.signal.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted || stream.signal.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      launchEntered = true;
      turn = options.startTurn({ ...options.request, onEvent });
      if (controller.signal.aborted) stopProvider();
      options.onAbortHandle(abort);
      result = await turn.result;
    } catch (error) {
      failure ??= `Provider attempt failed: ${String(error)}`;
      abort();
      // If registration/reporting threw after launch, still join the actual
      // handle. A local callback failure is not permission to orphan a child.
      let reaped: BackendRunResult | undefined;
      try {
        reaped = await turn?.result;
      } catch {
        // A rejected handle has no confirmed exit receipt.
      }
      result = reaped ?? {
        success: false,
        responseText: source.text,
        stdout: '',
        stderr: failure,
        exitCode: 1,
        durationMs: 0,
        command: 'stream-owned provider attempt',
        // A rejected handle is not proof its child exited.
        childExited: !launchEntered,
      };
    }
    if (result.childExited) stream.markGenerationEnded();
    if (!result.childExited) refuse('Provider exit is unconfirmed; this turn cannot continue.');
    if (result.success && !controller.signal.aborted) {
      // Only a successful, named confirmation can complete an EOF fence.
      // Failed attempts retain the prefix, never new work from final/stdout.
      try {
        source.confirm(result);
      } catch (error) {
        refuse(`Provider final refused; no further tools admitted: ${String(error)}`);
      }
    }
    const toolStream = await close(result.success && !controller.signal.aborted)!;
    failure ??= toolStream.failure?.message;
    // Dispatcher errors (including ordinary non-zero command exits) belong in
    // the model's result relay, not in provider failure. Their effects remain
    // unknown; the journal and admitted-prefix reseed guard still prevent an
    // automatic redispatch. Only a new model emission can request another call.
    if (failure) {
      // Reporting must not discard the known effects if the alert port fails.
      try {
        await options.ports.reportFailure(failure);
      } catch {
        failure += ' The host failure alert could not be delivered.';
      }
    }
    return {
      ...result,
      ...(failure || controller.signal.aborted
        ? { success: false, stderr: [result.stderr, failure].filter(Boolean).join('\n') }
        : {}),
      toolStream: {
        ...toolStream,
        ...(failure && !toolStream.failure
          ? { failure: { kind: 'executor' as const, message: failure } }
          : {}),
      },
    };
  } finally {
    // Also cover a launch/reporting port throwing. The source cannot outlive
    // this owner and continue accepting calls after the turn returns.
    try {
      await close(false);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      stream?.signal.removeEventListener('abort', abort);
    }
  }
}

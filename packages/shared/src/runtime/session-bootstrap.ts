/** The existing session identity/bootstrap sequence, independent of host I/O. */
import type { ContextLedger } from './context-ledger.js';
import { formatBootstrapContext } from './session-prompt.js';

export interface SessionBootstrapPorts {
  load(sbSlug: string): Promise<Record<string, unknown>>;
  ledger: ContextLedger;
  setTimezone(timezone: string): void;
  setContext(context: string): void;
  seedMemoryIds(ids: string[]): void;
  /** CLI preloads credentials here; a hosted session supplies its own preparation. */
  prepareHost(): Promise<void>;
  /** Required-bootstrap hosts throw here; the interactive CLI may warn and continue. */
  unavailable(reason: string): void;
}

/**
 * Caller-supplied identity skips database identity and recall seeding, not host
 * preparation. Otherwise load once, apply timezone/context, prepare the host,
 * seed recall dedup, then record the existing bootstrap ledger marker.
 *
 * This does not start a session or grant execution authority. The host owns
 * deadlines/cancellation of I/O; the signal fences application of late results.
 */
export async function bootstrapSessionIdentity(
  options: { sbSlug: string; systemPromptOverride?: string },
  ports: SessionBootstrapPorts,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if (options.systemPromptOverride) {
    await ports.prepareHost();
    signal?.throwIfAborted();
    return;
  }

  const result: Record<string, unknown> = await ports
    .load(options.sbSlug)
    .catch((error: unknown) => ({
      error: String(error),
    }));
  signal?.throwIfAborted();
  if (result.error) {
    ports.unavailable(`bootstrap unavailable: ${String(result.error)}`);
    return;
  }

  const suggestion = (result.reflectionStatus as Record<string, unknown> | undefined)?.suggestion;
  const timezone = (result.user as Record<string, unknown> | undefined)?.timezone;
  if (typeof timezone === 'string' && timezone.trim()) ports.setTimezone(timezone);
  const context = formatBootstrapContext(result);
  if (!context) ports.unavailable('bootstrap returned no identity context');
  if (context) ports.setContext(context);

  await ports.prepareHost();
  signal?.throwIfAborted();
  const memoryIds = result.memoryIds as string[] | undefined;
  if (memoryIds && memoryIds.length > 0) ports.seedMemoryIds(memoryIds);
  ports.ledger.addEntry(
    'system',
    `Bootstrapped as ${options.sbSlug}${timezone ? ` (${String(timezone)})` : ''}${
      suggestion ? `. ${String(suggestion)}` : ''
    }`,
    'bootstrap'
  );
}

/** Bind native steering only to an already admitted, owner-scoped full-tier generation. */
import { isAbsolute } from 'path';
import type { SessionSteeringRequest, SessionSteeringReceipt } from '@inklabs/shared/runtime';
import { verifyInkAccessToken } from '../../auth/ink-tokens';
import { getActiveRun, mayGenerationProceed, attachRunSteering } from './active-runs';
import { hasOwnTurnGate } from './trigger-delivery';
import { openNativeSteeringLog, type NativeSteeringLog } from './native-steering-log';

export interface NativeSteeringBinding {
  readonly turnEpoch: string;
  assertCurrent(): void;
  /** Call only once the runner knows the exact live native provider turn. */
  bind(enqueue: (request: SessionSteeringRequest) => Promise<SessionSteeringReceipt>): () => void;
  /** Open before provider spawn. This private log has no read or resume surface. */
  openLog(): Promise<NativeSteeringLog>;
}

export interface NativeSteeringAdmission {
  sessionId: string;
  turnEpoch: string;
  userId: string;
  sbId: string | null | undefined;
  sbSlug: string;
  contactId: string | null | undefined;
  cliAttached: boolean | undefined;
  identityMetadata: unknown;
  executionTier: 'tools' | 'full' | undefined;
  workingDirectory: string;
  inkAccessToken: string | undefined;
  container?: unknown;
  signal?: AbortSignal;
  admitSpawn?: () => string | undefined;
}

/** Unsupported or unverifiable targets keep their ordinary queued-input behavior. */
export function createNativeSteeringBinding(
  input: NativeSteeringAdmission
): NativeSteeringBinding | undefined {
  // Copy primitives now. Mutable identity metadata or caller config cannot grow
  // the capabilities of a generation that was admitted without this port.
  const { sessionId, turnEpoch, userId, sbId, sbSlug, workingDirectory, signal, admitSpawn } =
    input;
  if (
    input.executionTier !== 'full' ||
    input.container !== undefined ||
    input.contactId !== null ||
    input.cliAttached !== false ||
    !sbId ||
    !input.identityMetadata ||
    typeof input.identityMetadata !== 'object' ||
    Array.isArray(input.identityMetadata) ||
    hasOwnTurnGate(input.identityMetadata) ||
    !isAbsolute(workingDirectory) ||
    !/^[a-z0-9-]{1,128}$/i.test(sessionId) ||
    !/^[a-z0-9-]{1,128}$/i.test(turnEpoch)
  )
    return undefined;
  const claims = input.inkAccessToken
    ? verifyInkAccessToken(input.inkAccessToken, 'mcp_access')
    : null;
  if (
    !claims ||
    claims.type !== 'mcp_access' ||
    claims.sub !== userId ||
    claims.sbSlug !== sbSlug ||
    claims.sbId !== sbId ||
    (claims.identityId !== undefined && claims.identityId !== sbId) ||
    claims.sessionId !== sessionId ||
    claims.contactId !== undefined ||
    typeof claims.scope !== 'string' ||
    !claims.scope.split(/\s+/).includes('mcp:tools') ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  )
    return undefined;
  const expiresAt = claims.exp * 1000;
  const run = getActiveRun(sessionId);
  if (
    !run ||
    run.userId !== userId ||
    run.sbSlug !== sbSlug ||
    (run.backend !== 'claude-code' && run.backend !== 'codex-cli')
  )
    return undefined;
  let retired = false;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (
      retired ||
      getActiveRun(sessionId) !== run ||
      !mayGenerationProceed(sessionId, turnEpoch) ||
      run.runnerSettledAt !== undefined ||
      run.userId !== userId ||
      run.sbSlug !== sbSlug ||
      Date.now() >= expiresAt
    )
      throw new Error('Native steering generation is no longer admitted');
    const refusal = admitSpawn?.();
    if (refusal !== undefined) throw new Error('Native steering spawn admission was revoked');
  };
  try {
    assertCurrent();
  } catch {
    return undefined;
  }
  let opened: Promise<NativeSteeringLog> | undefined;
  let bound = false;
  return {
    turnEpoch,
    assertCurrent,
    openLog() {
      // Opening is single-shot. A failure is sticky, never a fresh empty journal.
      return (opened ??= (async () => {
        assertCurrent();
        const log = await openNativeSteeringLog({
          cwd: workingDirectory,
          sessionId,
          turnEpoch,
          signal,
        });
        try {
          assertCurrent();
          return log;
        } catch (error) {
          await log.close();
          throw error;
        }
      })());
    },
    bind(enqueue) {
      assertCurrent();
      if (bound) throw new Error('Native steering generation already has a mailbox');
      const releasePort = attachRunSteering(sessionId, turnEpoch, async (request) => {
        try {
          assertCurrent();
        } catch {
          return { messageId: request.messageId, status: 'refused', reason: 'owner_retired' };
        }
        const receipt = await enqueue(request);
        try {
          assertCurrent();
        } catch {
          if (receipt.status !== 'refused' && receipt.status !== 'unknown')
            return { ...receipt, status: 'unknown', reason: 'owner_changed_during_admission' };
        }
        return receipt;
      });
      bound = true;
      const release = () => {
        retired = true;
        releasePort();
        signal?.removeEventListener('abort', release);
      };
      signal?.addEventListener('abort', release, { once: true });
      // An AbortSignal can become aborted during listener registration.
      if (signal?.aborted) release();
      return release;
    },
  };
}

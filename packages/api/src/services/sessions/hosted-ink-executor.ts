/** The real shared Ink composition behind HostedInkSessionRunner, not a second loop. */
import {
  composeInkSession,
  resolveAttachments,
  buildAttachmentBlock,
  collectAttachmentDirs,
  type SessionCompositionPorts,
  type SessionControlsPorts,
} from '@inklabs/shared/node-host';
import {
  applyLaunchProfile,
  contextBudgetForWindow,
  resolveModelContextWindow,
  runHeadlessSession,
  estimateTokens,
  type SessionPromptSkill,
  type ToolCallResult,
  type SessionSteeringReceipt,
} from '@inklabs/shared/runtime';
import { promptTransportFor } from '@inklabs/shared/providers';
import { userFacingReplyText } from '@inklabs/shared';
import type {
  ExecuteHostedInkSession,
  HostedInkSessionInput,
  HostedInkSessionPorts,
} from './hosted-ink-session';
import type { ToolCall, RunnerTurnReply } from './types';

export interface HostedInkEffects extends Pick<
  SessionCompositionPorts,
  'toolHost' | 'policy' | 'cloneLog' | 'approve' | 'approveClone' | 'presentation' | 'mintId'
> {
  activeSkills: readonly SessionPromptSkill[];
  manualSkills?: SessionControlsPorts['skills'];
  controlReceipt?: SessionControlsPorts['receipt'];
  steeringReceipt?(receipt: SessionSteeringReceipt): void;
  /** Host closes its private resources only after all clone runs settle. */
  close(): Promise<void>;
  /** Persist queued policy changes before admission; approvals must do the same before returning true. */
  flushPolicy(): Promise<void>;
}
export type PrepareHostedInkEffects = (
  input: HostedInkSessionInput,
  ports: HostedInkSessionPorts
) => Promise<HostedInkEffects>;

/** Resource preparation is supplied by the server, never CLI env/cwd globals. */
export function createHostedInkExecutor(prepare: PrepareHostedInkEffects): ExecuteHostedInkSession {
  return async (input, ports) => {
    const providerContext = ports.provider.context;
    if (
      !input.sbSlug ||
      !providerContext ||
      providerContext.inkSessionId !== input.sessionId ||
      providerContext.workingDirectory !== input.workingDirectory ||
      providerContext.studioId !== input.studioId
    ) {
      throw new Error('Hosted Ink needs the admitted session, studio and directory context');
    }
    ports.signal.throwIfAborted();
    const effects = await prepare(input, ports);
    let releaseControls: (() => void) | undefined;
    let releaseSteering: (() => void) | undefined;
    let session: Awaited<ReturnType<typeof composeInkSession>> | undefined;
    const toolCalls: ToolCall[] = [];
    const backend = input.options.backend ?? 'claude';
    const backendTokenWindow = resolveModelContextWindow(backend, input.options.model);
    let lastText: string | undefined;
    let success = false;
    try {
      ports.signal.throwIfAborted();
      const applied = applyLaunchProfile(effects.policy, input.options.profile);
      if (
        !applied.ok ||
        (input.options.requireProfile && input.options.profile !== input.options.requireProfile)
      ) {
        throw new Error('Hosted Ink launch policy could not be applied');
      }
      await effects.flushPolicy();
      const spawnContext = {
        ...providerContext,
        withholdProviderTools: Boolean(
          providerContext.withholdProviderTools ||
          applied.withholdProviderTools ||
          input.options.withholdProviderTools
        ),
      };
      const history = await ports.sessionLog.read();
      const attachments = await resolveAttachments(input.attachments.map((media) => media.path));
      const attachmentBlock = buildAttachmentBlock(attachments);
      const attachmentDirs = collectAttachmentDirs(attachments);
      ports.signal.throwIfAborted();
      const callInk: SessionCompositionPorts['callInk'] = async (name, args) => {
        const result = await ports.inkwell.callTool(name, args, { signal: ports.signal });
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error(`Invalid result envelope from ${name}`);
        }
        return result as Record<string, unknown>;
      };
      session = await composeInkSession(
        {
          sbSlug: input.sbSlug,
          runtime: {
            sessionId: input.sessionId,
            studioId: input.studioId,
            backend,
            model: input.options.model,
            effort: input.options.effort,
            systemPromptOverride: input.options.systemPromptOverride,
            verbose: false,
            strictTools: true,
            backendTurnTimeoutMs: Math.max(1, ports.deadlineAt - Date.now()),
            backendTokenWindow,
            maxContextTokens: contextBudgetForWindow(
              backendTokenWindow,
              promptTransportFor(backend)
            ),
            toolMode: effects.policy.getMode(),
            toolRouting: input.options.toolRouting,
            activeSkills: effects.activeSkills,
            userTimezone: 'UTC',
          },
          cliAttached: false,
          contextBudgetAuto: true,
          history,
          log: ports.sessionLog,
          cwd: input.workingDirectory,
          toolHost: effects.toolHost,
          policy: effects.policy,
          controls: {
            skills: effects.manualSkills,
            receipt: effects.controlReceipt,
            assertCurrent: () => {
              ports.signal.throwIfAborted();
              ports.controls?.assertCurrent();
            },
          },
          steering: {
            turnEpoch: input.turnEpoch,
            receipt: effects.steeringReceipt,
            assertCurrent: () => {
              ports.signal.throwIfAborted();
              ports.steering?.assertCurrent();
            },
          },
          callInk,
          logActivity: async (activity) => {
            // Telemetry must neither disappear on normal failure nor hold the
            // user reply for the generic tool timeout. No retry/duplicate log.
            await ports.inkwell.callTool('log_activity', activity, {
              signal: AbortSignal.any([ports.signal, AbortSignal.timeout(5000)]),
            });
          },
          prepareHost: async () => {
            ports.signal.throwIfAborted();
          },
          unavailable: (reason) => {
            throw new Error(reason);
          },
          mintId: effects.mintId,
          spawnContext: () => spawnContext,
          startTurn: (request) =>
            ports.provider.startTurn({ ...request, inkSessionId: input.sessionId }),
          cloneLog: effects.cloneLog,
          approve: effects.approve,
          approveClone: effects.approveClone,
          presentation: {
            ...effects.presentation,
            toolResult: (result: ToolCallResult) => {
              effects.presentation.toolResult(result);
              if (result.invocationId)
                toolCalls.push({
                  toolUseId: result.invocationId,
                  toolName: result.tool,
                  input: result.args,
                });
            },
          },
        },
        ports.signal
      );
      const live = session;
      releaseControls = ports.controls?.bind((request) => live.controls.enqueue(request));
      const steering = live.steering;
      if (ports.steering) {
        if (!steering) throw new Error('Hosted steering composition is unavailable');
        releaseSteering = ports.steering.bind((request) => steering.enqueue(request));
      }
      const outer = await runHeadlessSession(
        {
          message: [input.message, attachmentBlock].filter(Boolean).join('\n\n'),
          messageLabel: input.options.messageLabel,
          maxTurns: input.options.maxTurns,
          repliesForwarded: Boolean(ports.output.onReply),
          signal: ports.signal,
        },
        {
          sessionSignal: live.sessionSignal,
          consecutiveBackendFailures: live.consecutiveBackendFailures,
          runTurn: async (turn, turnInput) => {
            let reply: RunnerTurnReply | undefined;
            let delivery: Promise<void> | undefined;
            let deliveryFailure: { error: unknown } | undefined;
            try {
              const completed = await live.run(
                {
                  ...turnInput,
                  media:
                    turn === 1
                      ? attachments
                          .filter((media) => !media.missing)
                          .map((media) => ({ path: media.path, mimeType: media.mime }))
                      : [],
                  attachmentDirs,
                },
                {
                  signal: ports.signal,
                  continueOnFailure: true,
                  onOutcome: (execution) => {
                    success = execution.loop.success;
                    lastText =
                      userFacingReplyText(execution.loop.assistantDisplayText) ?? undefined;
                    reply = {
                      turn,
                      label: turnInput.displayLabel || 'server',
                      text: lastText ?? null,
                      sends: [...live.stream.sends],
                      sessionId: input.sessionId,
                    };
                    // Begin at the committed-outcome boundary, before bounded turn_end hooks.
                    // Handle rejection immediately; the awaited handoff below still fails the run.
                    delivery = ports.output.onReply?.(reply).catch((error: unknown) => {
                      deliveryFailure = { error };
                    });
                  },
                }
              );
              if (!completed) throw new Error('Hosted Ink did not execute the admitted input');
            } finally {
              await delivery;
            }
            if (deliveryFailure) throw deliveryFailure.error;
          },
        }
      );
      await steering?.close('owner_completed');
      releaseSteering?.();
      // Close before the final sweep: no enqueue can fall between drain and release.
      live.controls.close();
      await live.controls.drain(ports.signal);
      releaseControls?.();
      ports.sessionLog.append({
        type: 'session_pause',
        sessionId: input.sessionId,
        turnsCompleted: outer.turnsCompleted,
        signal: outer.finalSignal ?? undefined,
      });
      await ports.sessionLog.flush();
      await callInk('update_session_state', {
        sbSlug: input.sbSlug,
        sessionId: input.sessionId,
        phase: outer.phase,
      }).catch(() => undefined);
      const totals = live.usage.totals;
      return {
        success: success && outer.exitReason !== 'backend_failure',
        responses: [],
        finalTextResponse: lastText,
        servedModel: live.stream.currentModel,
        usage: {
          inputTokens: totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
          modelUsage: live.usage.models,
          contextTokens:
            live.ledger.totalTokens() + estimateTokens(live.runtime.bootstrapContext ?? ''),
        },
        toolCalls,
      };
    } finally {
      releaseSteering?.();
      releaseControls?.();
      try {
        if (session) {
          try {
            await session.steering?.close('owner_stopped');
          } finally {
            session.controls.refusePending('owner_stopped');
            session.clones.cancel();
            await session.clones.drain();
          }
        }
      } finally {
        await effects.close();
      }
    }
  };
}

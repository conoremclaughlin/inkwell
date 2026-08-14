/**
 * Shadow clone wiring
 *
 * The pieces of the clone path composed for real: `runAgentLoop` driving
 * `executeToolCalls`, over a policy from `deriveClonePolicy`, with approvals
 * through `ApprovalCoordinator`, executing genuine Pi tools against files on
 * disk. Nothing here is mocked except the backend, which is scripted because
 * the LLM's judgement is not what is under test.
 *
 * The unit tests cover each piece in isolation. This covers the seams between
 * them, which is where the bugs in this feature actually live: a policy that
 * says no but an executor that runs anyway, an abort that reaches the loop but
 * not the approval it is blocked on, a clone that consumes its parent's grant.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runAgentLoop, type BackendTurnOutcome, type ToolResultRecord } from './agent-loop.js';
import { executeToolCalls } from './tool-call-executor.js';
import { ToolPolicyState } from './tool-policy.js';
import { applyToolApprovalChoice } from './tool-approval.js';
import { deriveClonePolicy, isForbiddenInClone } from './clone-policy.js';
import { ApprovalCoordinator, type ApprovalTicket } from './approval-coordinator.js';
import { callPiTool, isPiTool } from './pi-tools.js';
import {
  createSignalSink,
  getLastSignal,
  clearLastSignal,
  isClientLocalTool,
  handleClientLocalTool,
} from './context-tools.js';
import { ContextLedger } from './context-ledger.js';
import { boundSummary, describeCloneToolResult, screenIteration } from './spawn-agent.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'clone-wiring-'));
  writeFileSync(join(workdir, 'auth.ts'), 'export function login() {\n  return "token";\n}\n');
  writeFileSync(join(workdir, 'notes.md'), '# Notes\nlogin is defined in auth.ts\n');
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function inkTool(tool: string, args: Record<string, unknown> = {}): string {
  return '```ink-tool\n' + JSON.stringify({ tool, args }) + '\n```';
}

function backendOutcome(responseText: string, partial: Partial<BackendTurnOutcome> = {}) {
  return { success: true, stdout: '', stderr: '', responseText, ...partial };
}

const doneSignal = inkTool('signal_status', { status: 'completed' });

/**
 * A clone, wired the way `chat.ts` wires one: its own policy, its own ledger,
 * approvals routed through the shared coordinator with clone origin, Pi tools
 * against a real directory.
 */
function buildClone(opts: {
  parent: ToolPolicyState;
  coordinator: ApprovalCoordinator;
  cloneId: string;
  cloneLabel: string;
  turns: string[];
  signal?: AbortSignal;
  failAfter?: number;
}) {
  const { policy } = deriveClonePolicy(opts.parent);
  const ledger = new ContextLedger();
  const executed: string[] = [];
  const refused: Array<{ tool: string; status: string }> = [];
  let turnIndex = 0;

  const continuations: string[] = [];
  let backendTurns = 0;
  // What chat.ts gives a clone: its own signal sink, never the process global.
  const signalSink = createSignalSink();
  const runTurn = async (
    body: string,
    turnCtx: { isContinuation: boolean }
  ): Promise<BackendTurnOutcome> => {
    if (turnCtx.isContinuation) continuations.push(body);
    backendTurns += 1;
    const index = turnIndex++;
    if (opts.failAfter !== undefined && index >= opts.failAfter) {
      return { success: false, stdout: '', stderr: 'backend exploded', exitCode: 1 };
    }
    return backendOutcome(opts.turns[index] ?? doneSignal);
  };

  const run = () =>
    runAgentLoop(
      {
        prompt: 'clone prompt',
        toolRouting: 'local',
        signal: opts.signal,
        // What chat.ts gives a real clone. Without it the harness diverges from
        // production on exactly the path that matters here — a refused call
        // ending the clone's turn instead of being fed back.
        continueOnBlocked: true,
      },
      {
        ui: { printLine: () => {}, printEvent: () => {}, startWaiting: () => () => {} },
        tools: {
          screen: (all) => {
            const verdict = screenIteration(all, 5);
            return verdict.ok ? { calls: verdict.calls } : { rejected: verdict.reason };
          },
          execute: async (calls, ctx) => {
            const results: ToolResultRecord[] = [];
            await executeToolCalls(calls, {
              policy,
              sessionId: 'sess-1',
              // Production threads the turn signal here; without it the
              // executor cannot stop mid-batch.
              signal: ctx.signal,
              callTool: async (tool, args, callCtx) => {
                if (isForbiddenInClone(tool)) {
                  return {
                    content: [{ type: 'text', text: `${tool} is not available to a clone.` }],
                    isError: true,
                  } as PcpToolCallResult;
                }
                if (isClientLocalTool(tool)) {
                  const local = handleClientLocalTool(tool, args, ledger, signalSink);
                  if (local) return local;
                }
                if (isPiTool(tool)) {
                  executed.push(tool);
                  return callPiTool(tool, args, workdir, callCtx.signal);
                }
                executed.push(tool);
                return { content: [{ type: 'text', text: '{}' }] } as PcpToolCallResult;
              },
              promptForApproval: (tool, reason, args) =>
                opts.coordinator
                  .request({
                    tool,
                    args: args ?? {},
                    reason,
                    sessionId: 'sess-1',
                    origin: {
                      origin: 'clone',
                      cloneId: opts.cloneId,
                      cloneLabel: opts.cloneLabel,
                    },
                    signal: ctx.signal,
                    // Production passes the REQUESTER's policy. Omitting it is
                    // what let the coordinator recheck and mutate the parent.
                    policy,
                  })
                  .then((o) => o.approved),
              onResult: (result) => {
                if (result.status !== 'executed' && result.status !== 'approved') {
                  refused.push({ tool: result.tool, status: result.status });
                }
                results.push({
                  tool: result.tool,
                  // Same helper chat.ts uses — a mirror here could pass while
                  // the real mapping drifted.
                  result: describeCloneToolResult(result),
                  status: result.status,
                  args: result.args,
                });
              },
            });
            return results;
          },
        },
        backend: { runTurn },
      }
    );

  return {
    run,
    policy,
    executed,
    refused,
    continuations,
    signalSink,
    get backendTurns() {
      return backendTurns;
    },
  };
}

describe('shadow clone wiring', () => {
  it('reads real files through the clone envelope and reports back', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: async () => false,
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'find login',
      turns: [
        inkTool('grep', { pattern: 'login', path: '.' }),
        `login lives in auth.ts\n${doneSignal}`,
      ],
    });

    const result = await clone.run();

    expect(clone.executed).toContain('grep');
    expect(result.stopReason).toBe('terminal-signal');
    expect(result.assistantDisplayText).toContain('login lives in auth.ts');
    // The summary a parent would receive is bounded before it enters the ledger.
    expect(boundSummary(result.assistantDisplayText)).toBe('login lives in auth.ts');
  });

  it('refuses write-shaped tools without ever reaching the filesystem', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    let prompted = 0;
    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: async () => {
        prompted += 1;
        return true;
      },
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'try to write',
      turns: [
        inkTool('write', { path: 'pwned.txt', content: 'nope' }) +
          '\n' +
          inkTool('bash', { command: 'echo hi' }) +
          '\n' +
          inkTool('remember', { content: 'sneaky' }),
        doneSignal,
      ],
    });

    await clone.run();

    expect(clone.refused.map((r) => r.tool).sort()).toEqual(['bash', 'remember', 'write']);
    expect(clone.refused.every((r) => r.status === 'blocked')).toBe(true);
    expect(clone.executed).toEqual([]);
    // Hard denials never become questions — approving them is not the user's to
    // do, so nothing should have been asked.
    expect(prompted).toBe(0);
  });

  it('cannot spawn further clones even when it names the tool directly', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => true });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'try to nest',
      turns: [inkTool('spawn_agent', { tasks: [{ label: 'x', prompt: 'y' }] }), doneSignal],
    });

    await clone.run();
    expect(clone.refused).toEqual([{ tool: 'spawn_agent', status: 'blocked' }]);
    expect(clone.executed).toEqual([]);
  });

  it('routes an escalation to the coordinator carrying the clone label', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    // Outside the clone baseline and not hard-denied — it escalates.
    const tickets: ApprovalTicket[] = [];
    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: async (ticket) => {
        tickets.push(ticket);
        return false;
      },
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-2',
      cloneLabel: 'map test coverage',
      turns: [inkTool('save_link', { url: 'https://example.com' }), doneSignal],
    });

    await clone.run();

    expect(tickets).toHaveLength(1);
    expect(tickets[0].origin).toEqual({
      origin: 'clone',
      cloneId: 'clone-2',
      cloneLabel: 'map test coverage',
    });
    expect(clone.refused).toEqual([{ tool: 'save_link', status: 'denied' }]);
  });

  it('serializes escalations from concurrent clones onto the single input slot', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    let inFlight = 0;
    let maxInFlight = 0;
    const asked: string[] = [];

    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: async (ticket) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        asked.push(ticket.origin.cloneId ?? 'parent');
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return false;
      },
    });

    const clones = ['clone-1', 'clone-2', 'clone-3'].map((id) =>
      buildClone({
        parent,
        coordinator,
        cloneId: id,
        cloneLabel: id,
        turns: [inkTool('save_link', { url: 'https://example.com' }), doneSignal],
      })
    );

    await Promise.all(clones.map((c) => c.run()));

    expect(asked.sort()).toEqual(['clone-1', 'clone-2', 'clone-3']);
    // Two overlapping Ink prompts orphan the first promise forever. One at a time.
    expect(maxInFlight).toBe(1);
  });

  it('aborting the turn frees a clone blocked in an approval wait', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();
    let promptStarted = false;

    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      // Stands in for the Ink input slot: it waits forever unless aborted.
      prompt: (ticket) =>
        new Promise<boolean>((_resolve, reject) => {
          promptStarted = true;
          ticket.signal?.addEventListener('abort', () => {
            const err = new Error('Input aborted');
            err.name = 'InkInputAborted';
            reject(err);
          });
        }),
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'blocked on approval',
      signal: controller.signal,
      turns: [inkTool('save_link', { url: 'https://example.com' }), doneSignal],
    });

    const running = clone.run();
    await new Promise((r) => setTimeout(r, 10));
    expect(promptStarted).toBe(true);

    controller.abort();

    // Without the signal reaching the approval, this would sit for the full
    // 5-minute timeout and the test would hang rather than fail.
    const result = await running;
    expect(clone.refused).toEqual([{ tool: 'save_link', status: 'denied' }]);

    // And the abort has to TERMINATE the loop. A cancelled approval comes back
    // as a denial, which reads as `all-refused`; with continueOnBlocked that
    // previously started another backend turn — cancelling a clone spawned the
    // very work it was meant to stop, then reported success.
    expect(result.stopReason).toBe('aborted');
    expect(clone.backendTurns).toBe(1);
    expect(result.success).toBe(false);
  }, 5000);

  it('does not start another backend turn after an abort during approval', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();
    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: (ticket) =>
        new Promise<boolean>((_resolve, reject) => {
          ticket.signal?.addEventListener('abort', () => {
            const err = new Error('Input aborted');
            err.name = 'InkInputAborted';
            reject(err);
          });
        }),
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'cancelled mid-approval',
      signal: controller.signal,
      // A second scripted turn exists precisely so a continuation would be
      // visible if one happened.
      turns: [inkTool('save_link', { url: 'https://a.example' }), `kept working\n${doneSignal}`],
    });

    const running = clone.run();
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = await running;

    expect(clone.backendTurns).toBe(1);
    expect(result.stopReason).toBe('aborted');
    expect(result.assistantDisplayText).toBe('');
  }, 5000);

  it('one clone failing does not discard its siblings summaries', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => false });

    const good = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'good',
      turns: [inkTool('ls', { path: '.' }), `two files\n${doneSignal}`],
    });
    const bad = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-2',
      cloneLabel: 'bad',
      turns: [],
      failAfter: 0,
    });

    // allSettled, never all — this is the shape chat.ts uses for the fan-out.
    const settled = await Promise.allSettled([good.run(), bad.run()]);

    expect(settled[0].status).toBe('fulfilled');
    expect(settled[0].status === 'fulfilled' && settled[0].value.assistantDisplayText).toContain(
      'two files'
    );
    expect(settled[1].status === 'fulfilled' && settled[1].value.stopReason).toBe(
      'backend-failure'
    );
  });

  it('tells a clone what a thrown tool actually said', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => false });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'read a missing file',
      turns: [inkTool('read', { path: 'does-not-exist.ts' }), doneSignal],
    });

    await clone.run();

    // A thrown tool reports through `error`, a refused one through `reason`.
    // Reading only `reason` fed the clone "Tool read (error): undefined".
    expect(clone.refused).toEqual([{ tool: 'read', status: 'error' }]);
    const fed = clone.continuations.find((body) => body.includes('Tool read (error)'));
    expect(fed).toBeDefined();
    expect(fed).not.toContain('(error): undefined');
  });

  it('a clone cannot spend the parent one-use grant', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    parent.addPromptTool('save_link');
    parent.grantTool('save_link', 1);

    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => false });
    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'grant thief',
      turns: [inkTool('save_link', { url: 'https://example.com' }), doneSignal],
    });

    await clone.run();

    // The grant is untouched, and the parent can still spend it itself.
    expect(parent.listGrants()).toEqual([{ tool: 'save_link', uses: 1 }]);
    expect(parent.canCallPcpTool('save_link').allowed).toBe(true);
  });

  it('applies an approved clone escalation to the CLONE, and executes it', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });

    // Production-shaped handler: the choice is applied to the policy the ticket
    // was raised against, which for a clone is its own.
    const coordinator = new ApprovalCoordinator<ToolPolicyState>({
      concurrency: 1,
      prompt: async (ticket) => {
        const target = ticket.policy ?? parent;
        return applyToolApprovalChoice({
          policy: target,
          tool: ticket.tool,
          sessionId: ticket.sessionId,
          choice: 'once',
        }).approved;
      },
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'escalates once',
      turns: [inkTool('save_link', { url: 'https://a.example' }), `saved\n${doneSignal}`],
    });

    await clone.run();

    // The escalation actually RAN. Applying the grant to the parent instead
    // left the clone's own post-approval recheck blocking, so the call was
    // approved and then refused anyway.
    expect(clone.refused).toEqual([]);
    expect(clone.executed).toContain('save_link');

    // And the parent is untouched — no grant, no widened allowlist.
    expect(parent.listGrants()).toEqual([]);
    expect(parent.listAllowTools()).not.toContain('save_link');
    expect(parent.canCallPcpTool('save_link').allowed).toBe(true); // parent default, not a grant
  });

  it('does not let one clone escalation widen a sibling', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator<ToolPolicyState>({
      concurrency: 1,
      prompt: async (ticket) =>
        applyToolApprovalChoice({
          policy: ticket.policy ?? parent,
          tool: ticket.tool,
          sessionId: ticket.sessionId,
          // The broadest answer available, to prove even that stays local.
          choice: 'always',
        }).approved,
    });

    const first = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'asker',
      turns: [inkTool('save_link', { url: 'https://a.example' }), `done\n${doneSignal}`],
    });
    await first.run();
    expect(first.policy.listAllowTools()).toContain('save_link');

    // A sibling derived from the same parent starts from the parent envelope,
    // not from whatever its sibling was granted.
    const sibling = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-2',
      cloneLabel: 'sibling',
      turns: [`nothing to do\n${doneSignal}`],
    });
    expect(sibling.policy.listAllowTools()).not.toContain('save_link');
    expect(parent.listAllowTools()).not.toContain('save_link');
  });

  it('sibling clones do not rewrite each other policy', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    // The user answers "always" for the first clone that asks.
    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: async () => true,
    });

    const first = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'asker',
      turns: [inkTool('save_link', { url: 'https://a.example' }), doneSignal],
    });
    await first.run();
    first.policy.allowTool('save_link');

    // A sibling derived from the same parent starts from the parent envelope,
    // not from whatever its sibling accumulated.
    const { policy: sibling } = deriveClonePolicy(parent);
    expect(sibling.canCallPcpTool('save_link').allowed).toBe(false);
  });
});

describe('shadow clone isolation from parent process state', () => {
  it('does not let a clone signal completion on behalf of the parent', async () => {
    clearLastSignal();
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => false });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'signals when done',
      turns: [`all done\n${doneSignal}`],
    });

    const result = await clone.run();

    // The clone's own loop stopped on the signal...
    expect(result.stopReason).toBe('terminal-signal');
    expect(clone.signalSink.get()?.status).toBe('completed');
    // ...but runChat reads this global to decide whether the whole
    // non-interactive run completed. Every clone is instructed to signal, so a
    // shared sink lets a clone end its parent's run and lets concurrent clones
    // race for it.
    expect(getLastSignal()).toBeNull();
  });

  it('keeps concurrent clones' + String.fromCharCode(39) + ' signals separate', async () => {
    clearLastSignal();
    const parent = new ToolPolicyState('backend', { persist: false });
    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => false });

    const done = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'finishes',
      turns: [`done\n${doneSignal}`],
    });
    const stuck = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-2',
      cloneLabel: 'blocked',
      turns: [`cannot proceed\n${inkTool('signal_status', { status: 'blocked' })}`],
    });

    await Promise.all([done.run(), stuck.run()]);

    expect(done.signalSink.get()?.status).toBe('completed');
    expect(stuck.signalSink.get()?.status).toBe('blocked');
    expect(getLastSignal()).toBeNull();
  });
});

describe('shadow clone cancellation is authoritative', () => {
  it('does not run the rest of a batch after cancelling during the first approval', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();

    const coordinator = new ApprovalCoordinator({
      concurrency: 1,
      prompt: (ticket) =>
        new Promise<boolean>((_resolve, reject) => {
          ticket.signal?.addEventListener('abort', () => {
            const err = new Error('Input aborted');
            err.name = 'InkInputAborted';
            reject(err);
          });
        }),
    });

    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'cancelled mid-batch',
      signal: controller.signal,
      // save_link escalates and blocks on approval; read would run freely.
      turns: [
        `${inkTool('save_link', { url: 'https://a.example' })}\n${inkTool('read', { path: 'auth.ts' })}`,
        doneSignal,
      ],
    });

    const running = clone.run();
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = await running;

    // The batch stops where the cancellation landed. Checking only after the
    // whole batch returned let `read` execute against a turn the user had
    // already cancelled.
    expect(clone.executed).not.toContain('read');
    expect(result.stopReason).toBe('aborted');
  }, 5000);

  it('spends no backend invocation when the turn is already cancelled', async () => {
    const parent = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();
    controller.abort();

    const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt: async () => false });
    const clone = buildClone({
      parent,
      coordinator,
      cloneId: 'clone-1',
      cloneLabel: 'cancelled before starting',
      signal: controller.signal,
      turns: [inkTool('read', { path: 'auth.ts' }), doneSignal],
    });

    const result = await clone.run();

    // The opening spawn is the most expensive thing the loop does; proving a
    // cancelled turn is cancelled should not cost one.
    expect(clone.backendTurns).toBe(0);
    expect(result.stopReason).toBe('aborted');
    expect(result.success).toBe(false);
  });
});

describe('shadow clone cancellation reaches the tools themselves', () => {
  it('hands every dispatcher the signal, so no call site can drop it', async () => {
    // Driven through executeToolCalls — the boundary BOTH production
    // dispatchers (runCloneTools and runIterationTools) go through. An earlier
    // version of this test observed the wiring harness instead, so it stayed
    // green with the production fix reverted and proved nothing.
    const policy = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();
    const seen: Array<{ tool: string; signal?: AbortSignal }> = [];

    await executeToolCalls([{ tool: 'read', args: { path: 'auth.ts' }, raw: '' }], {
      policy,
      signal: controller.signal,
      callTool: async (tool, _args, callCtx) => {
        seen.push({ tool, signal: callCtx.signal });
        return { content: [{ type: 'text', text: 'ok' }] } as PcpToolCallResult;
      },
      promptForApproval: async () => false,
    });

    // The signal arrives as an argument. A dispatcher cannot forget to capture
    // what it is handed.
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBe(controller.signal);
  });

  it('actually interrupts an in-flight tool when the turn is cancelled', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();
    let observed: 'aborted' | 'completed' | 'none' = 'none';

    // A tool that only finishes when its signal fires — so this hangs rather
    // than passes if the signal never reaches it.
    const running = executeToolCalls([{ tool: 'bash', args: { command: 'sleep' }, raw: '' }], {
      policy,
      signal: controller.signal,
      callTool: (_tool, _args, callCtx) =>
        new Promise<PcpToolCallResult>((resolve) => {
          callCtx.signal?.addEventListener('abort', () => {
            observed = 'aborted';
            resolve({ content: [{ type: 'text', text: 'interrupted' }] } as PcpToolCallResult);
          });
        }),
      promptForApproval: async () => false,
    });

    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await running;

    expect(observed).toBe('aborted');
  }, 5000);

  it('stops a batch at the cancellation point rather than running the rest', async () => {
    const policy = new ToolPolicyState('backend', { persist: false });
    const controller = new AbortController();
    const ran: string[] = [];

    const results = await executeToolCalls(
      [
        { tool: 'read', args: {}, raw: '' },
        { tool: 'grep', args: {}, raw: '' },
      ],
      {
        policy,
        signal: controller.signal,
        callTool: async (tool) => {
          ran.push(tool);
          // Cancel while the first call is in flight.
          controller.abort();
          return { content: [{ type: 'text', text: 'ok' }] } as PcpToolCallResult;
        },
        promptForApproval: async () => false,
      }
    );

    expect(ran).toEqual(['read']);
    expect(results[1]).toMatchObject({ tool: 'grep', status: 'denied' });
  });
});

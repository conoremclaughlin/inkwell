/**
 * Tool discovery wiring
 *
 * A turn asking what it can call, composed for real: `runAgentLoop` extracting
 * the call, `executeToolCalls` clearing it through a genuine `ToolPolicyState`,
 * `createLocalToolDispatcher` answering it. Nothing is mocked but the backend
 * and the server round trip.
 *
 * This tier exists because of how the fix failed twice on its way in, and both
 * failures shared a shape: verified somewhere, inert where it counts.
 *
 *   1. The merge read the MCP envelope. Thirteen unit tests passed against
 *      mocks that wrapped their payload; `PcpClient.callTool` returns it
 *      already unwrapped, so against a live server the merge did nothing.
 *   2. The integration test then constructed the dispatcher itself. Deleting
 *      the wiring from `chat.ts` — the `audience`, the dispatcher, the policy
 *      entry — would not have failed a single test.
 *
 * So the assertion here is deliberately not "the merge function returns bash".
 * It is: **the text the model reads back contains the tools it can call**, and
 * it got there without a human approving anything. That is the claim an agent
 * actually depends on, and the only one that would have caught both.
 */

import { describe, expect, it } from 'vitest';

import { runAgentLoop, type BackendTurnOutcome, type ToolResultRecord } from './agent-loop.js';
import { executeToolCalls } from './tool-call-executor.js';
import { ToolPolicyState } from './tool-policy.js';
import { deriveClonePolicy, isForbiddenInClone } from './clone-policy.js';
import { createLocalToolDispatcher } from './tool-dispatch.js';
import { callPiTool } from './pi-tools.js';
import { handleClientLocalTool, isClientLocalTool, createSignalSink } from './context-tools.js';
import { ContextLedger } from './context-ledger.js';
import { listLocalTools, type LocalToolAudience } from './local-tool-catalog.js';
import { applyProfile, type ToolProfileId } from './tool-profiles.js';
import type { PcpToolCallResult } from '../lib/pcp-client.js';

function inkTool(tool: string, args: Record<string, unknown> = {}): string {
  return '```ink-tool\n' + JSON.stringify({ tool, args }) + '\n```';
}

/**
 * The Inkwell server's half, in the shape `PcpClient.callTool` hands back —
 * the payload, already unwrapped from the MCP envelope. Mocking the envelope
 * instead is failure (1) above.
 */
function serverDescribeTool(args: Record<string, unknown>): PcpToolCallResult {
  if (typeof args.name === 'string') {
    return {
      success: false,
      error: `No tool named "${args.name}" in the Inkwell MCP namespace.`,
    };
  }
  return {
    success: true,
    count: 3,
    // Includes tools a clone is hard-denied, so the clone case has
    // something real to filter. A server list of only-safe names would let a
    // broken filter pass.
    tools: ['bootstrap', 'recall', 'remember', 'send_response'],
    scope: 'This lists Inkwell MCP tools only.',
  };
}

/**
 * One turn, wired the way `chat.ts` wires it: a real policy with no human
 * behind it, the real dispatcher, real client-local handling.
 *
 * `promptForApproval` returns false on purpose. Nobody is watching — that is
 * Myra's seat, a headless spawn — so anything not already permitted is refused.
 * A discovery call that needs approval fails this harness, which is the point:
 * it is how an agent ends up learning its surface by being told no.
 *
 * `audience: 'clone'` takes the CLONE's whole envelope, not just the flag:
 * a policy from `deriveClonePolicy` and the refusal head `chat.ts` gives one.
 * Passing the flag alone — which the first version of this file did — is how a
 * clone-shaped assertion can pass against a parent-shaped session.
 */
async function runDiscoveryTurn(opts: {
  args?: Record<string, unknown>;
  audience?: LocalToolAudience;
  profile?: ToolProfileId;
  deny?: string[];
}) {
  const parentPolicy = new ToolPolicyState('backend', { persist: false });
  if (opts.profile) applyProfile(parentPolicy, opts.profile);
  const isClone = opts.audience === 'clone';
  const policy = isClone ? deriveClonePolicy(parentPolicy).policy : parentPolicy;
  for (const tool of opts.deny ?? []) policy.denyTool(tool);
  const ledger = new ContextLedger();
  const continuations: string[] = [];
  const refusals: Array<{ tool: string; status: string }> = [];
  let approvalsAsked = 0;
  let turn = 0;

  const turns = [
    inkTool('describe_tool', opts.args ?? {}),
    inkTool('signal_status', { status: 'completed' }),
  ];

  const result = await runAgentLoop(
    { prompt: 'what can I call?', toolRouting: 'local' },
    {
      ui: { printLine: () => {}, printEvent: () => {}, startWaiting: () => () => {} },
      backend: {
        runTurn: async (body, ctx) => {
          if (ctx.isContinuation) continuations.push(body);
          return {
            success: true,
            stdout: '',
            stderr: '',
            responseText: turns[turn++] ?? '',
          } satisfies BackendTurnOutcome;
        },
      },
      tools: {
        execute: async (calls, ctx) => {
          const results: ToolResultRecord[] = [];
          await executeToolCalls(calls, {
            policy,
            sessionId: 'sess-discovery',
            signal: ctx.signal,
            callTool: createLocalToolDispatcher({
              cwd: process.cwd(),
              callPi: callPiTool,
              callPcp: async (tool, args) =>
                tool === 'describe_tool'
                  ? serverDescribeTool(args)
                  : ({ success: true } as PcpToolCallResult),
              resolveCredentials: (args) => args,
              audience: opts.audience ?? 'parent',
              // What chat.ts wires: the LIVE policy decides visibility, so a
              // denial the static list never heard of still hides the tool.
              // inspectPcpTool — asking what exists must not spend grants.
              isHardDenied: (tool) => {
                const decision = policy.inspectPcpTool(tool, 'sess-discovery');
                return !decision.allowed && !decision.promptable;
              },
              // The head chat.ts gives each host, refusal included.
              head: (tool, args) => {
                if (isClone && isForbiddenInClone(tool)) {
                  return {
                    content: [
                      { type: 'text', text: `${tool} is not available to a shadow clone.` },
                    ],
                    isError: true,
                  } as PcpToolCallResult;
                }
                return isClientLocalTool(tool)
                  ? handleClientLocalTool(tool, args, ledger, createSignalSink())
                  : null;
              },
            }),
            promptForApproval: () => {
              approvalsAsked += 1;
              return Promise.resolve(false);
            },
            onResult: (r) => {
              if (r.status !== 'executed' && r.status !== 'approved') {
                refusals.push({ tool: r.tool, status: r.status });
              }
              results.push({
                tool: r.tool,
                result: r.result ?? r.reason,
                status: r.status,
                args: r.args,
              });
            },
          });
          return results;
        },
      },
    }
  );

  return { result, continuations, refusals, approvalsAsked };
}

describe('a turn that asks what it can call', () => {
  it('reads back its own coding and client-local tools, not just the server namespace', async () => {
    const { continuations, result } = await runDiscoveryTurn({});

    // The body fed back to the model — what it actually reads. Asserting on the
    // merge function's return value instead is what let a wiring deletion pass.
    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('bash');
    expect(seenByModel).toContain('signal_status');
    // And the server's half survived the merge.
    expect(seenByModel).toContain('send_response');

    const discovery = result.toolResults.find((r) => r.tool === 'describe_tool');
    expect(discovery?.status).toBe('executed');
    const payload = discovery?.result as { tools: string[]; runtimeTools: string[] };
    expect(payload.runtimeTools).toEqual(listLocalTools('parent').map((entry) => entry.name));
  });

  it('does not have to ask permission to find out, even under the minimal profile', async () => {
    // The `minimal` profile narrows the PCP surface to `group:ink-safe`, so
    // this is the seat where the safe-tools entry earns itself: without it
    // `describe_tool` is outside the allowlist and gets refused.
    //
    // Which matters because of how this started — three not-founds read as
    // three confirmations. A refusal reads exactly the same way, so gating
    // discovery means the agent learns its surface by being told no.
    const { refusals, approvalsAsked, result, continuations } = await runDiscoveryTurn({
      profile: 'minimal',
    });

    expect(refusals).toEqual([]);
    expect(approvalsAsked).toBe(0);
    expect(result.stopReason).toBe('terminal-signal');

    // And the answer is honest about that profile rather than generous: minimal
    // denies group:write, so `bash` is genuinely uncallable here and is left
    // out, while the reads it does have are listed. This expectation used to
    // say `toContain('bash')`, written when visibility came from the audience
    // flag alone — the live policy is what makes it wrong.
    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('read');
    expect(seenByModel).toContain('grep');
    expect(seenByModel).not.toContain('"bash"');
  });

  it('describes bash to the agent rather than denying it exists', async () => {
    const { continuations } = await runDiscoveryTurn({ args: { name: 'bash' } });

    const seenByModel = continuations.join('\n');
    // Pi's own description and schema, reaching the model through the loop.
    expect(seenByModel).toContain('Execute a bash command');
    expect(seenByModel).toContain('command');
    // The sentence that sent Myra looking for a shell she already had.
    expect(seenByModel).not.toContain('No tool named "bash"');
  });

  it('tells a clone the truth about its narrower surface, server half included', async () => {
    const { continuations } = await runDiscoveryTurn({ audience: 'clone' });

    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('read');
    expect(seenByModel).toContain('recall');
    // A clone may not run a shell or fan out; listing them spends its turns on
    // calls the executor will refuse.
    expect(seenByModel).not.toContain('"bash"');
    expect(seenByModel).not.toContain('spawn_agent');
    // And the same has to hold for the SERVER's half. Narrowing only the local
    // additions left every hard-denied write tool advertised.
    expect(seenByModel).not.toContain('send_response');
    expect(seenByModel).not.toContain('remember');
  });

  it('tells a clone bash exists rather than that it does not', async () => {
    const { continuations } = await runDiscoveryTurn({
      audience: 'clone',
      args: { name: 'bash' },
    });

    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('exists in this runtime');
    // The clone's derived policy really does deny bash, so the reason given is
    // the policy — not the catalog. Naming the check that actually excluded it
    // is the point: a message that guessed would be a confident wrong answer
    // about its own reasoning.
    expect(seenByModel).toContain('denies it outright');
    expect(seenByModel).toContain('let your parent act on it');
    // The sentence that started all of this, now wrong for a second reason.
    expect(seenByModel).not.toContain('No tool named');
  });

  it('says AUDIENCE, not policy, when the catalog is what excluded it', async () => {
    // collect_agents is the live case for the other branch: off a clone's
    // catalog (it cannot spawn, so it has nothing to collect) but not denied by
    // CLONE_DENIED_TOOLS, so the policy has no opinion. Reporting a denial here
    // would state a reason nothing checked.
    const { continuations } = await runDiscoveryTurn({
      audience: 'clone',
      args: { name: 'collect_agents' },
    });

    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('not available to a shadow clone');
    expect(seenByModel).not.toContain('denies it outright');
  });
});

/**
 * Discovery and execution, checked against each other.
 *
 * Every earlier round of this PR asserted what I believed each side did. The
 * defect each time was that the two sides disagreed, which is invisible to any
 * assertion that only ever looks at one of them. So this drives BOTH through
 * one policy and requires the answers to match.
 */
describe('discovery agrees with what execution will actually do', () => {
  it('keeps a denied client-local tool discoverable, because it still runs', async () => {
    // executeOneToolCall returns before the policy check for client-local tools
    // (tool-call-executor.ts:119), so denying signal_status does not stop it.
    // Filtering it out of discovery for that denial would hide a tool the agent
    // demonstrably has — the original bug, rebuilt inside its own fix.
    const { continuations, result, refusals } = await runDiscoveryTurn({
      deny: ['signal_status'],
    });

    // Discovered...
    expect(continuations.join('\n')).toContain('signal_status');
    // ...and executed, in the same run, under the same denial. The loop only
    // stops on `terminal-signal` if signal_status actually ran.
    expect(result.stopReason).toBe('terminal-signal');
    expect(refusals).toEqual([]);
    expect(result.toolResults.find((r) => r.tool === 'signal_status')?.status).toBe('executed');
  });

  it('describes a denied client-local tool instead of claiming policy blocks it', async () => {
    const { continuations } = await runDiscoveryTurn({
      deny: ['signal_status'],
      args: { name: 'signal_status' },
    });

    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('completed');
    expect(seenByModel).not.toContain('denies it outright');
  });

  it('still hides a denied tool that policy genuinely does stop', async () => {
    // The exemption is for client-local tools only. `bash` goes through policy,
    // so a denial there is real and discovery must reflect it.
    const { continuations } = await runDiscoveryTurn({ deny: ['bash'] });

    const seenByModel = continuations.join('\n');
    expect(seenByModel).not.toContain('"bash"');
    expect(seenByModel).toContain('read');
  });
});

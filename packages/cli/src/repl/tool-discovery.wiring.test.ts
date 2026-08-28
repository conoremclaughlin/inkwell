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
    tools: ['bootstrap', 'recall', 'send_response'],
    scope: 'This lists Inkwell MCP tools only.',
  };
}

/**
 * One turn, wired the way `chat.ts` wires the parent: a real policy with no
 * human behind it, the real dispatcher, real client-local handling.
 *
 * `promptForApproval` returns false on purpose. Nobody is watching — that is
 * Myra's seat, a headless spawn — so anything not already permitted is refused.
 * A discovery call that needs approval fails this harness, which is the point:
 * it is how an agent ends up learning its surface by being told no.
 */
async function runDiscoveryTurn(opts: {
  args?: Record<string, unknown>;
  audience?: LocalToolAudience;
  profile?: ToolProfileId;
}) {
  const policy = new ToolPolicyState('backend', { persist: false });
  if (opts.profile) applyProfile(policy, opts.profile);
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
              head: (tool, args) =>
                isClientLocalTool(tool)
                  ? handleClientLocalTool(tool, args, ledger, createSignalSink())
                  : null,
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
    expect(continuations.join('\n')).toContain('bash');
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

  it('tells a clone the truth about its narrower surface', async () => {
    const { continuations } = await runDiscoveryTurn({ audience: 'clone' });

    const seenByModel = continuations.join('\n');
    expect(seenByModel).toContain('read');
    // A clone may not run a shell or fan out; listing them spends its turns on
    // calls the executor will refuse.
    expect(seenByModel).not.toContain('"bash"');
    expect(seenByModel).not.toContain('spawn_agent');
  });
});

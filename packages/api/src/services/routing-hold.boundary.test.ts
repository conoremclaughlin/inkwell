/**
 * The refuse-and-hold boundary in server.ts, executed without importing
 * server.ts (which ends in an unconditional `startServer(...)`).
 *
 * `refuseAndHold` rebuilds the hold detail by hand before handing it to
 * `stampRoutingHold`. That copy is where a field goes missing with a green
 * suite: the routing-hold module tests persist whatever they are given, and
 * the session-service tests stop at the thrown refusal. On #681 the
 * `project` a project-without-repo refusal carries was dropped here, so every
 * persisted hold read `project: null` (Lumen, round 1). This test runs the
 * real closure against a fake RPC and reads the stamped hold back.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { stampRoutingHold } from './routing-hold';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The `const refuseAndHold = async (...) => {...}` statement, by AST — no line numbers to rot. */
function extractRefuseAndHold(): string {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);
  let text = '';
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && d.name.text === 'refuseAndHold'
      )
    ) {
      text = node.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!text) throw new Error('const refuseAndHold = ... not found in server.ts');
  return text;
}

function makeRefuseAndHold(deps: {
  logger: { error: ReturnType<typeof vi.fn> };
  rpc: ReturnType<typeof vi.fn>;
}) {
  const js = ts.transpileModule(`${extractRefuseAndHold()}\nreturn refuseAndHold;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(
    'logger',
    'logInkmail',
    'payload',
    'userId',
    'targetSlug',
    'threadWorkspaceId',
    'routeStartedAt',
    'dataComposer',
    'stampRoutingHold',
    js
  )(
    deps.logger,
    vi.fn(async () => undefined),
    { threadId: 'thread-1' },
    'user-1',
    'wren',
    'ws-1',
    '2026-09-25T20:00:00.000Z',
    { getClient: () => ({ rpc: deps.rpc }) },
    stampRoutingHold
  ) as (refusal: {
    threadKey: string;
    detail: Record<string, unknown>;
    message: string;
  }) => Promise<void>;
}

describe('refuseAndHold (server.ts) — the persisted hold keeps the refusal whole', () => {
  it('carries the pinned project into the stamped hold, and the log names the fix', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const logger = { error: vi.fn() };
    const refuse = makeRefuseAndHold({ logger, rpc });

    await refuse({
      threadKey: 'inktrade:pr:1',
      message: 'held',
      detail: {
        triedCallerRepo: false,
        reason: 'project-without-repo',
        project: { slug: 'inktrade', cause: 'unset' },
      },
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    const hold = (rpc.mock.calls[0] as unknown[])[1] as { p_hold: Record<string, unknown> };
    expect(hold.p_hold.reason).toBe('project-without-repo');
    expect(hold.p_hold.project).toEqual({ slug: 'inktrade', cause: 'unset' });
    expect(hold.p_hold.recovery).toContain('repo_root');
    const logged = logger.error.mock.calls[0][1] as Record<string, unknown>;
    expect(logged.project).toEqual({ slug: 'inktrade', cause: 'unset' });
    expect(String(logged.recovery)).toContain('save_project');
  });

  it('control: a no-route refusal stamps project null and the generic recovery', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const logger = { error: vi.fn() };
    const refuse = makeRefuseAndHold({ logger, rpc });

    await refuse({
      threadKey: 'pr:1',
      message: 'held',
      detail: { triedCallerRepo: true, callerRepoRoot: '/repos/inkwell', reason: 'no-route' },
    });

    const hold = (rpc.mock.calls[0] as unknown[])[1] as { p_hold: Record<string, unknown> };
    expect(hold.p_hold.project).toBeNull();
    expect(hold.p_hold.recovery).toBe('route pattern, studioHint, or project affinity');
  });
});

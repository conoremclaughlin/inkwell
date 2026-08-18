/**
 * Boundary regressions for the arguments first-party code actually sends.
 *
 * Strict tool args (#511) turned unknown keys from silently-stripped into
 * rejected. My verification for that change tested tools I picked by hand and
 * they all passed, which felt like evidence and wasn't: the failure mode lives
 * on the CALLER side — "does the argument this existing code already sends
 * still validate?" — and no amount of sampling the callee surfaces it. Lumen
 * grepped the repo instead and found three live breakages (PR #511 review).
 *
 * So this file is organised by call site, not by tool. Each case names the file
 * and line that sends these args. If a schema change breaks a real caller, this
 * goes red rather than the breakage reaching a user as an empty session list or
 * a dropped memory write.
 *
 * Keep adding cases here when new first-party callers appear.
 */

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from './index';

/**
 * A data layer that responds to anything. `then` must be undefined or the
 * proxy looks like a thenable to `await`, and any handler that awaits it hangs
 * forever instead of failing — which cost me two mystery 5s timeouts.
 */
function makeStub(): any {
  const stub: any = new Proxy(function () {} as any, {
    get: (_target, prop) => (prop === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub,
  });
  return stub;
}

async function connectedClient() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const stub: any = makeStub();
  registerAllTools(server as any, stub);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Assert the args pass *validation*. The stubbed data layer means the handler
 * itself will fail, and that is fine and deliberate — we are testing the
 * contract at the boundary, not the handler's behaviour. What must never
 * appear is a validation rejection naming one of these parameters.
 */
async function expectArgsAccepted(tool: string, args: Record<string, unknown>) {
  const client = await connectedClient();
  const result: any = await client
    .callTool({ name: tool, arguments: args })
    .catch((error: Error) => ({ content: [{ text: error.message }] }));

  const text = JSON.stringify(result.content ?? result);
  expect(text).not.toMatch(/[Uu]nrecognized key/);
  expect(text).not.toMatch(/Invalid arguments for tool/);
}

describe('real caller args survive validation', () => {
  it('list_sessions from ink attach — chat.ts:3218, 3275, 3391, 3796', async () => {
    await expectArgsAccepted('list_sessions', { agentId: 'wren', status: 'active', limit: 30 });
    await expectArgsAccepted('list_sessions', {
      agentId: 'wren',
      status: 'active',
      backend: 'ink',
      limit: 30,
    });
    await expectArgsAccepted('list_sessions', { limit: 20, status: 'active' });
  });

  it('list_sessions from ink mission — mission.ts:730', async () => {
    await expectArgsAccepted('list_sessions', {
      email: 'someone@example.test',
      status: 'active',
      limit: 40,
      agentId: 'wren',
    });
  });

  it('update_session_state from the session-start hook — hooks.ts:2109', async () => {
    // `lifecycle` is the field the drifted inline schema used to strip, which
    // made the startup idle stamp a silent no-op.
    await expectArgsAccepted('update_session_state', {
      email: 'someone@example.test',
      agentId: 'wren',
      sessionId: '00000000-0000-4000-8000-000000000000',
      lifecycle: 'idle',
      workingDir: '/tmp',
      backendSessionId: 'abc123',
      activeThreadKey: 'pr:511',
    });
  });

  it('update_session_state from claude attach — claude.ts:3381', async () => {
    await expectArgsAccepted('update_session_state', {
      email: 'someone@example.test',
      agentId: 'wren',
      sessionId: '00000000-0000-4000-8000-000000000000',
      backendSessionId: 'abc123',
      status: 'active',
      workingDir: '/tmp',
    });
  });

  it('remember from chat /eject — chat.ts:7162', async () => {
    await expectArgsAccepted('remember', {
      agentId: 'wren',
      sessionId: '00000000-0000-4000-8000-000000000000',
      content: 'Context ejection at bookmark-1.',
      topics: 'repl,context-ejection',
      salience: 'medium',
    });
  });
});

describe('the registered contract matches the one the handler enforces', () => {
  it('declares every parameter its own handler parses', async () => {
    // The three breakages above all had the same root cause: index.ts
    // registered a hand-copied duplicate of a schema the handler parses with,
    // and the copy drifted. Registering the canonical object makes drift
    // impossible; this asserts the three that had diverged stay converged.
    const { rememberSchema, listSessionsSchema, updateSessionStateSchema } =
      await import('./memory-handlers');

    const captured = new Map<string, unknown>();
    const server: any = {
      registerTool: (name: string, config: any) => captured.set(name, config?.inputSchema),
    };
    const stub: any = new Proxy(function () {} as any, {
      get: () => stub,
      apply: () => stub,
      construct: () => stub,
    });
    registerAllTools(server, stub);

    // strictify wraps these, so compare the declared key sets rather than
    // object identity.
    const keysOf = (schema: any) => Object.keys(schema.shape ?? {}).sort();

    expect(keysOf(captured.get('remember'))).toEqual(keysOf(rememberSchema));
    expect(keysOf(captured.get('list_sessions'))).toEqual(keysOf(listSessionsSchema));
    expect(keysOf(captured.get('update_session_state'))).toEqual(keysOf(updateSessionStateSchema));
  });
});

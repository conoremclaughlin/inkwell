/**
 * Does the RUNNING /token endpoint tell a client WHICH kind of refusal it got?
 *
 * The provider now distinguishes a dead grant from a grant it could not check,
 * and the CLI deletes `~/.ink/auth.json` on exactly one of those answers. That
 * distinction only reaches the client if the endpoint transmits it — a handler
 * that sends every refusal as 400 makes the classification a comment.
 *
 * The handler is extracted from the source by AST rather than imported.
 * `mcp/server.ts` exports a class whose construction pulls in the data
 * composer, the channel gateway and the whole tool registry; reaching one arrow
 * function through it would be a different test with different failure modes.
 * Everything under the handler is injected, so the only production code running
 * is the handler itself.
 *
 * Technique borrowed from inbound-agent-handler.probe.test.ts (Lumen, #638).
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/** Pull the real `/token` POST handler out of mcp/server.ts without importing it. */
function extractTokenHandler(): string {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true);

  let arrow = '';
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(ast) === 'post' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === '/token'
    ) {
      arrow = node.arguments[node.arguments.length - 1].getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);

  if (!arrow) {
    throw new Error(
      "the POST '/token' handler was not found in mcp/server.ts — re-point this probe"
    );
  }
  return arrow;
}

// The handler is an arrow, so it takes `this` from where it is DEFINED. It is
// therefore defined inside a function called with the stand-in MCPServer,
// rather than bound afterwards — `.call()` on an arrow does nothing.
const compiled = ts.transpileModule(
  `const makeHandler = function () { return ${extractTokenHandler()}; };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

interface Sent {
  status: number;
  body: unknown;
}

/**
 * Run the extracted handler against a refusal the provider returns.
 *
 * `this` is the MCPServer instance; the handler reaches `this.authProvider` and
 * the module-scope `logger`, and nothing else on this path.
 */
async function runRefresh(providerAnswer: unknown): Promise<Sent> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const self = {
    authProvider: {
      exchangeRefreshToken: vi.fn(async () => providerAnswer),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const handler = new Function('logger', 'self', `${compiled}; return makeHandler.call(self);`)(
    logger,
    self
  );

  const sent: Sent = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };

  await handler(
    { body: { grant_type: 'refresh_token', refresh_token: 'pcp-rt-x', client_id: 'sb-cli' } },
    res
  );

  return sent;
}

describe('POST /token — transmitting which refusal it was', () => {
  it('sends a dead grant as 400 invalid_grant', async () => {
    const sent = await runRefresh({
      error: 'invalid_grant',
      error_description: 'Invalid refresh token',
    });

    expect(sent.status).toBe(400);
    expect(sent.body).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid refresh token',
    });
  });

  it('sends an unanswerable check as 503, not as a dead grant', async () => {
    // The whole point. A CLI that cannot tell these apart deletes the machine's
    // credential because the database was busy for a second.
    const sent = await runRefresh({
      error: 'temporarily_unavailable',
      error_description: 'The grant could not be checked.',
      http_status: 503,
    });

    expect(sent.status).toBe(503);
    expect(sent.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The grant could not be checked.',
    });
  });

  it('sends a superseded secret as 409 with the grant still alive', async () => {
    const sent = await runRefresh({
      error: 'superseded_grant',
      error_description: 'This refresh token has been replaced.',
      http_status: 409,
    });

    expect(sent.status).toBe(409);
    expect(sent.body).toEqual({
      error: 'superseded_grant',
      error_description: 'This refresh token has been replaced.',
    });
  });

  it('never puts the transport hint in the body', async () => {
    // `http_status` is how the provider names a status to the handler. It is
    // not part of the OAuth error response and must not reach a client.
    const sent = await runRefresh({ error: 'superseded_grant', http_status: 409 });

    expect(sent.body).not.toHaveProperty('http_status');
  });

  it('still answers a successful exchange with the token', async () => {
    // The control: a handler that refused everything would satisfy all four
    // assertions above.
    const sent = await runRefresh({
      access_token: 'at',
      refresh_token: 'rt',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:tools',
    });

    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ access_token: 'at' });
  });
});

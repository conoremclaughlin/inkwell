/**
 * Where the account gate is entered (ink://specs/account-deletion v6 §3),
 * pinned in the source, as interrupt-active-runs.test.ts pins the turn
 * epoch's threading. The gate itself is tested in gate.test.ts, the admin
 * middleware's refusal in routes/admin-auth.test.ts, and the drain end to end
 * in worker.integration.test.ts; these pins make each seam's wiring a visible
 * change rather than a silent one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (path: string) => readFileSync(join(__dirname, '..', '..', path), 'utf8');

describe('the account gate is entered at every seam', () => {
  it("an inkling turn enters its owner's gate before its folder is prepared, and runTurn releases it after the end hook", () => {
    const service = src('services/sessions/session-service.ts');
    const processStart = service.indexOf('private async processMessage(');
    const enter = service.indexOf(
      'accountLeases.push(accountGate.enter(inklingIdentity.userId))',
      processStart
    );
    const folder = service.indexOf('ensureInklingFolder(', processStart);
    expect(enter).toBeGreaterThan(processStart);
    expect(folder).toBeGreaterThan(enter);

    const run = service.indexOf('private async runTurn(');
    const process = service.indexOf(
      'this.processMessage(request, session, turnEpochCandidate, accountLeases)',
      run
    );
    const endHook = service.indexOf("this.callTurnHook('end'", run);
    const release = service.indexOf('for (const lease of accountLeases) lease.release();', run);
    const finallyAt = service.lastIndexOf('} finally {', release);
    expect(process).toBeGreaterThan(run);
    expect(endHook).toBeGreaterThan(process);
    expect(finallyAt).toBeGreaterThan(endHook);
    expect(release).toBeGreaterThan(finallyAt);
  });

  it('the MCP route and token delegation lease the account once it is resolved', () => {
    const server = src('mcp/server.ts');
    const challenge = server.indexOf('if (shouldChallenge) {');
    const lease = server.indexOf('!leaseAccountForRequest(res, userData.userId', challenge);
    const context = server.indexOf('const ctx = userData', challenge);
    expect(lease).toBeGreaterThan(challenge);
    expect(context).toBeGreaterThan(lease);

    const delegate = server.indexOf("app.post('/token/delegate'");
    expect(
      server.indexOf('if (!leaseAccountForRequest(res, userData.userId)) return;', delegate)
    ).toBeGreaterThan(delegate);
  });

  it('chat-auth resolves by sign-in and leases before calling next', () => {
    const chat = src('routes/chat-auth.ts');
    const resolve = chat.indexOf('resolveAccountForPrincipal(');
    const lease = chat.indexOf('leaseAccountForRequest(res, resolved.userId)');
    const next = chat.indexOf('next();');
    expect(resolve).toBeGreaterThan(-1);
    expect(lease).toBeGreaterThan(resolve);
    expect(next).toBeGreaterThan(lease);
  });

  it('every mobile route that mints credentials leases the account first', () => {
    const admin = src('routes/admin.ts');
    for (const [route, leased] of [
      ["router.post('/auth/mobile-login'", 'leaseAccountForRequest(res, inkUser.id)'],
      ["router.post('/auth/mobile-signup'", 'leaseAccountForRequest(res, inkUser.id)'],
      ["router.post('/auth/mobile-pair/claim'", 'leaseAccountForRequest(res, user.id)'],
      ["router.post('/auth/mobile-refresh'", 'leaseAccountForRequest(res, result.userId)'],
    ] as const) {
      const start = admin.indexOf(route);
      const end = admin.indexOf('\nrouter.', start + route.length);
      const at = admin.indexOf(leased, start);
      expect(start, route).toBeGreaterThan(-1);
      expect(at, route).toBeGreaterThan(start);
      expect(at, route).toBeLessThan(end);
    }
  });

  it("an upload enters its space's gate before its first await", () => {
    const uploads = src('routes/thread-uploads.ts');
    const handler = uploads.indexOf('export async function postUpload(');
    const enter = uploads.indexOf('spaceGate.enter(auth.inkWorkspaceId)', handler);
    const firstAwait = uploads.indexOf('await ', handler);
    expect(enter).toBeGreaterThan(handler);
    expect(firstAwait).toBeGreaterThan(enter);
  });
});

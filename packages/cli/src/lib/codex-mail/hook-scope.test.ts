import { describe, expect, it } from 'vitest';
import { isCodexMailHookScope } from './hook-scope.js';

const context = {
  sessionId: 'fixture-session',
  studioId: 'fixture-studio',
  sbSlug: 'fixture',
  runtime: 'codex',
  cliAttached: true,
};
const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const env = {
  INK_CODEX_INKMAIL: '1',
  INK_SESSION_ID: context.sessionId,
  INK_STUDIO_ID: context.studioId,
  SB_SLUG: context.sbSlug,
  INK_CONTEXT: token(context),
};
describe('bridge-only hook scope', () => {
  it('allows only the exact attached Codex context', () => {
    expect(isCodexMailHookScope(env)).toBe(true);
  });
  it.each([
    {},
    { ...env, INK_CODEX_INKMAIL: undefined },
    { ...env, INK_TURN_OWNER: 'parent' },
    { ...env, INK_CONTEXT: undefined },
    { ...env, INK_CONTEXT: 'invalid' },
    { ...env, INK_CONTEXT: token(null) },
    ...['sessionId', 'studioId', 'sbSlug', 'runtime', 'cliAttached'].flatMap((key) => [
      { ...env, INK_CONTEXT: token({ ...context, [key]: undefined }) },
      { ...env, INK_CONTEXT: token({ ...context, [key]: 'wrong' }) },
    ]),
    // A server-shaped run stays inert even if the bridge flag leaks in.
    { ...env, INK_CONTEXT: token({ ...context, cliAttached: false }) },
  ])('refuses absent, headless, parent-owned or mismatched context %#', (value) => {
    expect(isCodexMailHookScope(value)).toBe(false);
  });
});

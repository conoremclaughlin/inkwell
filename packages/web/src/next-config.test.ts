/**
 * The dashboard's Next config. In development, Next logs every server
 * function call with its arguments unless `logging.serverFunctions` is off,
 * and the sign-in action's arguments are an email address and a password.
 * This loads the config the way `next dev` does and reads the flag the way
 * Next's server does.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import loadConfig from 'next/dist/server/config';

const webDir = path.resolve(__dirname, '..');
const appDir = path.join(__dirname, 'app');

/** Every URL path the app router serves a page at; `(group)` folders add no segment. */
function pagePaths(dir = appDir, segments: string[] = []): Set<string> {
  const paths = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && /^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      paths.add('/' + segments.join('/'));
    } else if (entry.isDirectory()) {
      const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
      const next = isGroup ? segments : [...segments, entry.name];
      for (const p of pagePaths(path.join(dir, entry.name), next)) paths.add(p);
    }
  }
  return paths;
}

describe('next.config', () => {
  it('sends the old Reminders address to the Scheduled page, and both ends are real', async () => {
    const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, webDir);
    const redirects = (await config.redirects?.()) ?? [];
    expect(redirects).toContainEqual(
      expect.objectContaining({ source: '/reminders', destination: '/scheduled', permanent: true })
    );
    // A redirect to a path with no page is a 404 with extra steps, and a page
    // left at a redirected path is never reached.
    const pages = pagePaths();
    for (const redirect of redirects) {
      expect(pages, `destination of ${redirect.source}`).toContain(redirect.destination);
      expect(pages, `source of ${redirect.source}`).not.toContain(redirect.source);
    }
  });

  it('does not log server function arguments in development', async () => {
    const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, webDir);
    // This file's config was the one loaded, not Next's defaults alone.
    expect(typeof config.rewrites).toBe('function');
    // base-server.js: logServerFunctions.
    const logsServerFunctions =
      typeof config.logging === 'object' && Boolean(config.logging.serverFunctions);
    expect(logsServerFunctions).toBe(false);
  });
});

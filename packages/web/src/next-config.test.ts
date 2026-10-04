/**
 * The dashboard's Next config. In development, Next logs every server
 * function call with its arguments unless `logging.serverFunctions` is off,
 * and the sign-in action's arguments are an email address and a password.
 * This loads the config the way `next dev` does and reads the flag the way
 * Next's server does.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import loadConfig from 'next/dist/server/config';

const webDir = path.resolve(__dirname, '..');

describe('next.config', () => {
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

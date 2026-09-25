#!/usr/bin/env node

import concurrently from 'concurrently';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeEnv } from './lib/runtime-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// One env loader for everything that acts on the runtime's behalf: the same
// layers, aliases and precedence as packages/api/src/config/env.ts, so the
// preflight's stack proof reads the SUPABASE_URL the server will use.
const { env: runtimeEnv, loadedFiles: loadedEnvFiles, nodeEnv } = resolveRuntimeEnv(rootDir);
for (const [key, value] of Object.entries(runtimeEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

if (loadedEnvFiles.length > 0) {
  console.log(`[dev] Loaded env: ${loadedEnvFiles.join(' → ')} (NODE_ENV=${nodeEnv})`);
}

function parsePort(rawValue, fallback, envName) {
  if (rawValue === undefined || rawValue === '') return fallback;

  const trimmed = String(rawValue).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `[dev] Invalid ${envName}="${rawValue}". Expected an integer between 1 and 65535.`
    );
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(
      `[dev] Invalid ${envName}="${rawValue}". Expected an integer between 1 and 65535.`
    );
  }

  return parsed;
}

const basePort = parsePort(
  process.env.INK_PORT_BASE || process.env.PCP_PORT_BASE,
  3001,
  'INK_PORT_BASE'
);
const webPort = parsePort(process.env.WEB_PORT, basePort + 1, 'WEB_PORT');
const myraPort = parsePort(process.env.MYRA_HTTP_PORT, basePort + 2, 'MYRA_HTTP_PORT');
const apiUrl = process.env.API_URL || `http://localhost:${basePort}`;

console.log('Starting concurrent dev mode');
console.log(`  INK_PORT_BASE=${basePort}`);
console.log(`  WEB_PORT=${webPort}`);
console.log(`  MYRA_HTTP_PORT=${myraPort}`);
console.log(`  API_URL=${apiUrl}`);
console.log(`  ENABLE_TELEGRAM=${process.env.ENABLE_TELEGRAM ?? '<auto>'}`);
console.log(`  ENABLE_HEARTBEAT_SERVICE=${process.env.ENABLE_HEARTBEAT_SERVICE ?? '<unset>'}`);

// Build @inklabs/shared before starting servers — the API imports its CJS
// dist at runtime, and a stale or missing build will crash on startup.
import { execSync } from 'node:child_process';
try {
  execSync('yarn workspace @inklabs/shared build', {
    cwd: rootDir,
    stdio: 'inherit',
  });
} catch {
  console.error('[dev] Failed to build @inklabs/shared — API may not start correctly');
}

// Ensure node_modules/.bin is on PATH so hoisted binaries (next, tsx, etc.)
// are resolvable by yarn script shells spawned via concurrently.
const binDir = path.join(rootDir, 'node_modules', '.bin');
const envPATH = `${binDir}:${process.env.PATH || ''}`;

const apiEnv = {
  ...process.env,
  PATH: envPATH,
  INK_PORT_BASE: String(basePort),
  MYRA_HTTP_PORT: String(myraPort),
  API_URL: apiUrl,
  ENABLE_TELEGRAM: process.env.ENABLE_TELEGRAM ?? '',
  ENABLE_WHATSAPP: process.env.ENABLE_WHATSAPP ?? 'false',
  ENABLE_DISCORD: process.env.ENABLE_DISCORD ?? 'false',
};

const webEnv = {
  ...process.env,
  PATH: envPATH,
  INK_PORT_BASE: String(basePort),
  WEB_PORT: String(webPort),
  API_URL: apiUrl,
};

const { result } = concurrently(
  [
    {
      command: 'yarn workspace @inklabs/shared tsc --watch --preserveWatchOutput',
      name: 'shared:esm',
      prefixColor: 'cyan',
      env: { ...process.env, PATH: envPATH },
    },
    {
      command:
        'yarn workspace @inklabs/shared tsc -p tsconfig.cjs.json --watch --preserveWatchOutput',
      name: 'shared:cjs',
      prefixColor: 'cyan',
      env: { ...process.env, PATH: envPATH },
    },
    {
      command: 'yarn workspace @inklabs/api server:dev',
      name: 'api',
      prefixColor: 'blue',
      env: apiEnv,
    },
    {
      command: 'yarn workspace @inklabs/web dev',
      name: 'web',
      prefixColor: 'magenta',
      env: webEnv,
    },
  ],
  {
    killOthersOn: ['failure', 'success'],
  }
);

try {
  await result;
} catch (error) {
  console.error('[dev] Concurrent dev startup failed.', error);
  process.exit(1);
}

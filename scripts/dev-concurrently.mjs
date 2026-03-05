#!/usr/bin/env node

import concurrently from 'concurrently';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const nodeEnv = process.env.NODE_ENV || 'development';
const envAliases = {
  dev: 'development',
  prod: 'production',
};

function resolveEnvFile(envName) {
  const canonical = path.resolve(rootDir, `.env.${envName}`);
  if (existsSync(canonical)) return canonical;

  for (const [short, long] of Object.entries(envAliases)) {
    if (long === envName) {
      const alias = path.resolve(rootDir, `.env.${short}`);
      if (existsSync(alias)) return alias;
    }
  }
  return null;
}

function applyEnvLayer(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  const parsed = dotenv.parse(readFileSync(filePath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const loadedEnvFiles = [];
const envLocalPath = path.resolve(rootDir, '.env.local');
if (applyEnvLayer(envLocalPath)) loadedEnvFiles.push('.env.local');
const envSpecific = resolveEnvFile(nodeEnv);
if (applyEnvLayer(envSpecific)) loadedEnvFiles.push(path.basename(envSpecific));
const envBasePath = path.resolve(rootDir, '.env');
if (applyEnvLayer(envBasePath)) loadedEnvFiles.push('.env');

if (loadedEnvFiles.length > 0) {
  console.log(`[dev] Loaded env: ${loadedEnvFiles.join(' → ')} (NODE_ENV=${nodeEnv})`);
}

const basePort = Number(process.env.PCP_PORT_BASE || 3001);
const webPort = Number(process.env.WEB_PORT || basePort + 1);
const myraPort = Number(process.env.MYRA_HTTP_PORT || basePort + 2);
const apiUrl = process.env.API_URL || `http://localhost:${basePort}`;

console.log('Starting concurrent dev mode');
console.log(`  PCP_PORT_BASE=${basePort}`);
console.log(`  WEB_PORT=${webPort}`);
console.log(`  MYRA_HTTP_PORT=${myraPort}`);
console.log(`  API_URL=${apiUrl}`);
console.log(`  ENABLE_TELEGRAM=${process.env.ENABLE_TELEGRAM ?? '<auto>'}`);
console.log(`  ENABLE_HEARTBEAT_SERVICE=${process.env.ENABLE_HEARTBEAT_SERVICE ?? '<unset>'}`);

const apiEnv = {
  ...process.env,
  PCP_PORT_BASE: String(basePort),
  MYRA_HTTP_PORT: String(myraPort),
  API_URL: apiUrl,
  ENABLE_TELEGRAM: process.env.ENABLE_TELEGRAM ?? '',
  ENABLE_WHATSAPP: process.env.ENABLE_WHATSAPP ?? 'false',
  ENABLE_DISCORD: process.env.ENABLE_DISCORD ?? 'false',
};

const webEnv = {
  ...process.env,
  PCP_PORT_BASE: String(basePort),
  WEB_PORT: String(webPort),
  API_URL: apiUrl,
};

const { result } = concurrently(
  [
    {
      command: 'yarn workspace @personal-context/api server:dev',
      name: 'api',
      prefixColor: 'blue',
      env: apiEnv,
    },
    {
      command: 'yarn workspace @personal-context/web dev',
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
} catch {
  process.exit(1);
}

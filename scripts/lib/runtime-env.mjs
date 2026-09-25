/**
 * The environment the runtime will actually see, resolved the one way the
 * server resolves it (packages/api/src/config/env.ts), so that anything that
 * decides on the runtime's behalf (the startup preflight proving which stack
 * it may migrate) reads the same values the server will.
 *
 * Precedence, highest first: the process environment (a defined value wins,
 * an empty string included), then `.env.local`, then `.env.{NODE_ENV}` with
 * the `.env.dev` / `.env.prod` shorthand as fallback, then `.env`. Every
 * layer only fills keys still undefined. Files are parsed by dotenv, as the
 * server parses them. Nothing here mutates process.env.
 */

import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { basename, resolve } from 'path';

export const ENV_ALIASES = { dev: 'development', prod: 'production' };

/** `.env.<envName>`, or its shorthand alias, or null when neither exists. */
export function resolveEnvFile(rootDir, envName) {
  const canonical = resolve(rootDir, `.env.${envName}`);
  if (existsSync(canonical)) return canonical;
  for (const [short, long] of Object.entries(ENV_ALIASES)) {
    if (long === envName) {
      const alias = resolve(rootDir, `.env.${short}`);
      if (existsSync(alias)) return alias;
    }
  }
  return null;
}

export function resolveRuntimeEnv(rootDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const nodeEnv = env.NODE_ENV || 'development';
  const loadedFiles = [];
  const apply = (file, label) => {
    if (!file || !existsSync(file)) return;
    const parsed = dotenv.parse(readFileSync(file));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
    loadedFiles.push(label);
  };
  apply(resolve(rootDir, '.env.local'), '.env.local');
  const specific = resolveEnvFile(rootDir, nodeEnv);
  if (specific) apply(specific, basename(specific));
  apply(resolve(rootDir, '.env'), '.env');
  return { env, loadedFiles, nodeEnv };
}

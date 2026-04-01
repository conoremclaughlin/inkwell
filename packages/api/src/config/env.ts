import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { resolve, basename } from 'path';
import { z } from 'zod';

// Load environment variables with priority (highest wins):
// 1. Shell environment (always wins)
// 2. .env.local (gitignored, machine-specific overrides)
// 3. .env.{NODE_ENV} (environment-specific: .env.development, .env.production, .env.test)
// 4. .env (base config, can be committed)
//
// Shorthand aliases: .env.dev → .env.development, .env.prod → .env.production
// Files are loaded from project root.
const projectRoot = resolve(__dirname, '../../../../');

// Detect NODE_ENV early (before loading files, so we know which env file to pick)
const nodeEnv = process.env.NODE_ENV || 'development';

// Map shorthand aliases to canonical names
const envAliases: Record<string, string> = {
  dev: 'development',
  prod: 'production',
};

/**
 * Resolve the environment-specific .env file path.
 * Checks canonical name first (.env.development), then shorthand (.env.dev).
 */
function resolveEnvFile(envName: string): string | null {
  const canonical = resolve(projectRoot, `.env.${envName}`);
  if (existsSync(canonical)) return canonical;

  // Check shorthand alias (e.g., .env.dev for development)
  for (const [short, long] of Object.entries(envAliases)) {
    if (long === envName) {
      const alias = resolve(projectRoot, `.env.${short}`);
      if (existsSync(alias)) return alias;
    }
  }
  return null;
}

/**
 * Apply vars from a parsed env file into process.env.
 * Only sets a var if it's not already set by a higher-priority source.
 */
function applyEnvLayer(parsed: Record<string, string>, appliedBy: Set<string>): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (!appliedBy.has(key) && process.env[key] === undefined) {
      process.env[key] = value;
      appliedBy.add(key);
    }
  }
}

// Track which files were loaded for console output
const loadedFiles: string[] = [];
// Track keys set by higher-priority layers so lower layers don't overwrite
const appliedBy = new Set<string>();

// Snapshot shell env keys before any file loading
const shellEnvKeys = new Set(Object.keys(process.env));
for (const key of shellEnvKeys) appliedBy.add(key);

// Layer 1 (highest file priority): .env.local
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  applyEnvLayer(parsed, appliedBy);
  loadedFiles.push('.env.local');
}

// Layer 2: .env.{NODE_ENV} (e.g., .env.development, .env.dev, .env.production, .env.prod)
const envSpecificPath = resolveEnvFile(nodeEnv);
if (envSpecificPath) {
  const parsed = dotenv.parse(readFileSync(envSpecificPath));
  applyEnvLayer(parsed, appliedBy);
  loadedFiles.push(basename(envSpecificPath));
}

// Layer 3 (lowest file priority): .env
const envBasePath = resolve(projectRoot, '.env');
if (existsSync(envBasePath)) {
  const parsed = dotenv.parse(readFileSync(envBasePath));
  applyEnvLayer(parsed, appliedBy);
  loadedFiles.push('.env');
}

// Log which env files are active
if (loadedFiles.length > 0) {
  console.log(`[env] Loaded: ${loadedFiles.join(' → ')} (NODE_ENV=${nodeEnv})`);
}

// Helper to handle optional strings (treat empty string as undefined)
const optionalString = z
  .string()
  .optional()
  .transform((val) => (val === '' ? undefined : val));
const optionalUrl = z
  .string()
  .url()
  .optional()
  .or(z.literal(''))
  .transform((val) => (val === '' ? undefined : val));
const optionalNumber = z
  .string()
  .optional()
  .or(z.literal(''))
  .transform((val) => (val === '' || val === undefined ? undefined : Number(val)));

// Environment variable schema
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  INK_PORT_BASE: z.string().transform(Number).optional(),
  PCP_PORT_BASE: z.string().transform(Number).optional(), // backward compat
  PORT: z.string().transform(Number).optional(),

  // Database - Supabase (supports both old and new naming conventions)
  SUPABASE_URL: z.string().url(),
  // New naming convention (preferred)
  SUPABASE_PUBLISHABLE_KEY: optionalString,
  SUPABASE_SECRET_KEY: optionalString,
  // Old naming convention (fallback)
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_KEY: optionalString,

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_BENSON_BOT_TOKEN: optionalString,
  TELEGRAM_WEBHOOK_URL: optionalUrl,

  // MCP Server
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_PORT: z.string().transform(Number).optional(),
  MCP_BASE_URL: optionalUrl, // Public base URL (e.g., https://pcp.example.com). Defaults to http://localhost:{MCP_HTTP_PORT}
  MCP_AUTH_TOKEN: optionalString,
  MCP_REQUIRE_OAUTH: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Myra (persistent messaging process)
  MYRA_HTTP_PORT: z.string().transform(Number).optional(),

  // Authentication
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Logging & Monitoring
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SENTRY_DSN: optionalUrl,

  // Discord Bot
  DISCORD_BOT_TOKEN: optionalString,
  DISCORD_APPLICATION_ID: optionalString,

  // Slack Bot
  SLACK_BOT_TOKEN: optionalString,
  SLACK_APP_TOKEN: optionalString,

  // Identity enforcement
  ENFORCE_IDENTITY_PINNING: z.enum(['true', 'false']).default('true'),

  // OAuth - Google
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  OAUTH_REDIRECT_BASE_URL: optionalUrl, // OAuth callback URL - can be origin only (http://localhost:3001) or full URL (http://localhost:3001/api/admin/oauth/google/callback)

  // Embeddings
  MEMORY_EMBEDDINGS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MEMORY_EMBEDDING_PROVIDER: z.enum(['ollama', 'openai']).optional(),
  MEMORY_EMBEDDING_MODEL: optionalString,
  MEMORY_EMBEDDING_DIMENSIONS: optionalNumber,
  MEMORY_EMBEDDING_QUERY_THRESHOLD: optionalNumber,
  MEMORY_EMBEDDING_MATCH_COUNT_MULTIPLIER: optionalNumber,
  OLLAMA_BASE_URL: optionalUrl,
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalUrl,
});

// Parse and validate environment variables
const parseEnv = () => {
  try {
    const parsed = envSchema.parse(process.env);

    // Validate that we have at least one set of Supabase keys
    const hasNewKeys = parsed.SUPABASE_PUBLISHABLE_KEY && parsed.SUPABASE_SECRET_KEY;
    const hasOldKeys = parsed.SUPABASE_ANON_KEY && parsed.SUPABASE_SERVICE_KEY;

    if (!hasNewKeys && !hasOldKeys) {
      throw new Error(
        'Missing Supabase keys. Provide either:\n' +
          '  - SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY (recommended), or\n' +
          '  - SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY (legacy)'
      );
    }

    // Create normalized keys (prefer INK_, fall back to PCP_ for backward compat)
    const hasBaseOverride = parsed.INK_PORT_BASE !== undefined || parsed.PCP_PORT_BASE !== undefined;
    // Base is MCP-first: MCP=base, WEB=base+1, MYRA=base+2
    const portBase = parsed.INK_PORT_BASE ?? parsed.PCP_PORT_BASE ?? 3001;

    // If INK_PORT_BASE is provided and legacy defaults are still present,
    // treat those defaults as unset so the base can drive derived ports.
    const port =
      parsed.PORT === undefined || (hasBaseOverride && parsed.PORT === 3000)
        ? portBase - 1
        : parsed.PORT;
    const mcpHttpPort =
      parsed.MCP_HTTP_PORT === undefined || (hasBaseOverride && parsed.MCP_HTTP_PORT === 3001)
        ? portBase
        : parsed.MCP_HTTP_PORT;
    const myraHttpPort =
      parsed.MYRA_HTTP_PORT === undefined || (hasBaseOverride && parsed.MYRA_HTTP_PORT === 3003)
        ? portBase + 2
        : parsed.MYRA_HTTP_PORT;
    const memoryEmbeddingDimensions = parsed.MEMORY_EMBEDDING_DIMENSIONS ?? 1024;
    const memoryEmbeddingQueryThreshold = parsed.MEMORY_EMBEDDING_QUERY_THRESHOLD ?? 0.2;
    const memoryEmbeddingMatchCountMultiplier = parsed.MEMORY_EMBEDDING_MATCH_COUNT_MULTIPLIER ?? 5;

    return {
      ...parsed,
      INK_PORT_BASE: portBase,
      PORT: port,
      MCP_HTTP_PORT: mcpHttpPort,
      MYRA_HTTP_PORT: myraHttpPort,
      SUPABASE_PUBLISHABLE_KEY: parsed.SUPABASE_PUBLISHABLE_KEY || parsed.SUPABASE_ANON_KEY,
      SUPABASE_SECRET_KEY: parsed.SUPABASE_SECRET_KEY || parsed.SUPABASE_SERVICE_KEY,
      OLLAMA_BASE_URL: parsed.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      MEMORY_EMBEDDING_DIMENSIONS: memoryEmbeddingDimensions,
      MEMORY_EMBEDDING_QUERY_THRESHOLD: memoryEmbeddingQueryThreshold,
      MEMORY_EMBEDDING_MATCH_COUNT_MULTIPLIER: memoryEmbeddingMatchCountMultiplier,
    } as typeof parsed & {
      INK_PORT_BASE: number;
      PORT: number;
      MCP_HTTP_PORT: number;
      MYRA_HTTP_PORT: number;
      SUPABASE_PUBLISHABLE_KEY: string;
      SUPABASE_SECRET_KEY: string;
      OLLAMA_BASE_URL: string;
      MEMORY_EMBEDDING_DIMENSIONS: number;
      MEMORY_EMBEDDING_QUERY_THRESHOLD: number;
      MEMORY_EMBEDDING_MATCH_COUNT_MULTIPLIER: number;
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Environment validation failed:\n${missingVars}`);
    }
    throw error;
  }
};

export const env = parseEnv();

// Helper functions
export const isDevelopment = () => env.NODE_ENV === 'development';
export const isProduction = () => env.NODE_ENV === 'production';
export const isTest = () => env.NODE_ENV === 'test';

import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

// Load environment variables with priority:
// 1. .env.local (highest priority, gitignored, local overrides)
// 2. .env (base config, can be committed)
// Files are loaded from project root
const projectRoot = resolve(__dirname, '../../../../');

// Load .env first (base)
const envBaseResult = dotenv.config({ path: resolve(projectRoot, '.env') });
const envBase = envBaseResult.parsed ?? {};

const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  // Apply .env.local as overrides for .env, but NEVER override explicit shell env.
  const envLocal = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(envLocal)) {
    const current = process.env[key];
    const cameFromBaseEnv = current !== undefined && current === envBase[key];
    if (current === undefined || cameFromBaseEnv) {
      process.env[key] = value;
    }
  }
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

// Environment variable schema
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PCP_PORT_BASE: z.string().transform(Number).optional(),
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

  // Agent Configuration
  DEFAULT_MODEL: z.string().default('sonnet'),

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

    // Create normalized keys (prefer new naming)
    const hasBaseOverride = parsed.PCP_PORT_BASE !== undefined;
    // Base is MCP-first: MCP=base, WEB=base+1, MYRA=base+2
    const portBase = parsed.PCP_PORT_BASE ?? 3001;

    // If PCP_PORT_BASE is provided and legacy defaults are still present,
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

    return {
      ...parsed,
      PCP_PORT_BASE: portBase,
      PORT: port,
      MCP_HTTP_PORT: mcpHttpPort,
      MYRA_HTTP_PORT: myraHttpPort,
      SUPABASE_PUBLISHABLE_KEY: parsed.SUPABASE_PUBLISHABLE_KEY || parsed.SUPABASE_ANON_KEY,
      SUPABASE_SECRET_KEY: parsed.SUPABASE_SECRET_KEY || parsed.SUPABASE_SERVICE_KEY,
    } as typeof parsed & {
      PCP_PORT_BASE: number;
      PORT: number;
      MCP_HTTP_PORT: number;
      MYRA_HTTP_PORT: number;
      SUPABASE_PUBLISHABLE_KEY: string;
      SUPABASE_SECRET_KEY: string;
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

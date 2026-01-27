import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

// Load environment variables with priority:
// 1. .env.local (highest priority, gitignored, local overrides)
// 2. .env (base config, can be committed)
// Files are loaded from project root
const projectRoot = resolve(__dirname, '../../../../');

// Load .env first (base), then .env.local (overrides)
dotenv.config({ path: resolve(projectRoot, '.env') });

const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

// Helper to handle optional strings (treat empty string as undefined)
const optionalString = z.string().optional().transform(val => val === '' ? undefined : val);
const optionalUrl = z.string().url().optional().or(z.literal('')).transform(val => val === '' ? undefined : val);

// Environment variable schema
const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),

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
  MCP_HTTP_PORT: z.string().transform(Number).default('3001'),
  MCP_AUTH_TOKEN: optionalString,

  // Myra (persistent messaging process)
  MYRA_HTTP_PORT: z.string().transform(Number).default('3003'),

  // Authentication
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Logging & Monitoring
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  SENTRY_DSN: optionalUrl,

  // Agent Configuration
  DEFAULT_MODEL: z.string().default('sonnet'),
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
    return {
      ...parsed,
      SUPABASE_PUBLISHABLE_KEY: parsed.SUPABASE_PUBLISHABLE_KEY || parsed.SUPABASE_ANON_KEY,
      SUPABASE_SECRET_KEY: parsed.SUPABASE_SECRET_KEY || parsed.SUPABASE_SERVICE_KEY,
    } as typeof parsed & {
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

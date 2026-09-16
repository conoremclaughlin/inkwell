/**
 * LIVE test project setup — env loading ONLY.
 *
 * Live suites talk to real services (a running PCP server, real LLM
 * backends, local hardware) and each gates itself on an explicit env flag
 * (INK_LIVE_TESTS=1 etc.). Unlike setup.ts, this file provides NO fake
 * credential fallbacks — a fake SUPABASE_URL would make a DB-dependent live
 * gate look configured — and unlike integration-setup.ts it runs no DB
 * safety guard, which would otherwise abort non-DB live suites (mlx-tts)
 * before their own env gate is even evaluated (Lumen, PR #439 round 3).
 */

import { config } from 'dotenv';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../../../../');

// Load repo-level env files if present (shell env always wins). Real values
// only — no fallbacks.
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

if (process.env.NODE_ENV === 'production') {
  throw new Error('Cannot run live tests in production environment');
}

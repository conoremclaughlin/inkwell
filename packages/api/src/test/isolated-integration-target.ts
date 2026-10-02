/**
 * Is this process pointed at the isolated integration-DB stack?
 *
 * A suite that WRITES to the database must run only there. The shared local
 * stack is also on 127.0.0.1, so integration-setup.ts's localhost check cannot
 * tell the two apart, and a harness marker alone is not enough either: a shell
 * can carry INTEGRATION_SUPABASE_WORKDIR beside an inherited shared
 * SUPABASE_URL (Lumen, PR #723). So this applies the harness's own rule
 * (scripts/lib/assert-isolated-supabase-url.sh): SUPABASE_URL must be exactly
 * http://127.0.0.1:<the API port the harness reserved>, and nothing else.
 *
 * - not-under-harness: no marker. An ordinary run; the suite is skipped.
 * - mismatch: the marker is there but the target is not the isolated stack.
 *   The suite must refuse loudly, never quietly run against whatever it got.
 * - isolated: run.
 *
 * Pure: reads only the env it is given, so it is tested without a database.
 * The rejected URL is never returned or printed; it can carry credentials.
 */
export type IsolatedIntegrationTarget =
  | { kind: 'isolated' }
  | { kind: 'not-under-harness' }
  | { kind: 'mismatch'; expected: string };

export function isolatedIntegrationTarget(
  env: Record<string, string | undefined>
): IsolatedIntegrationTarget {
  if (!env.INTEGRATION_SUPABASE_WORKDIR) return { kind: 'not-under-harness' };
  const port = env.INTEGRATION_MANAGED_API_PORT ?? '';
  if (!/^[0-9]+$/.test(port)) {
    return { kind: 'mismatch', expected: 'a numeric INTEGRATION_MANAGED_API_PORT' };
  }
  const expected = `http://127.0.0.1:${port}`;
  if (env.SUPABASE_URL !== expected) return { kind: 'mismatch', expected };
  return { kind: 'isolated' };
}

/**
 * For a DB-writing suite's module scope: true to run, false to skip, and a
 * thrown error (failing the file) for a harness marker with the wrong target.
 */
export function shouldRunOnIsolatedIntegrationDb(
  env: Record<string, string | undefined> = process.env
): boolean {
  const target = isolatedIntegrationTarget(env);
  if (target.kind === 'mismatch') {
    throw new Error(
      `Refusing to run: SUPABASE_URL is not the isolated integration stack (expected exactly ${target.expected}). The value is not shown; inspect it in your own shell.`
    );
  }
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY;
  return target.kind === 'isolated' && !!key;
}

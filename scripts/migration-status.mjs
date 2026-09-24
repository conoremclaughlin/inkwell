#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { resolve as resolvePath } from 'path';
import { existsSync, readFileSync } from 'fs';

function parseArgs(argv) {
  const args = {
    workdir: process.cwd(),
    json: false,
    warnOnly: false,
    quiet: false,
    target: 'auto',
    printTarget: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--warn-only') {
      args.warnOnly = true;
      continue;
    }
    if (token === '--quiet') {
      args.quiet = true;
      continue;
    }
    if (token === '--workdir') {
      args.workdir = resolvePath(argv[i + 1] || process.cwd());
      i += 1;
      continue;
    }
    if (token === '--target') {
      const next = String(argv[i + 1] || '')
        .trim()
        .toLowerCase();
      if (next === 'linked' || next === 'local' || next === 'auto') {
        args.target = next;
        i += 1;
      }
      continue;
    }
    if (token === '--linked') {
      args.target = 'linked';
      continue;
    }
    if (token === '--local') {
      args.target = 'local';
      continue;
    }
    if (token === '--print-target') {
      args.printTarget = true;
      continue;
    }
  }

  return args;
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const candidate = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
      const eqIndex = candidate.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = candidate.slice(0, eqIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = candidate.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function isLocalSupabaseUrl(value) {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function resolveTarget(args) {
  if (args.target === 'local' || args.target === 'linked') return args.target;

  const override = String(process.env.INK_MIGRATION_TARGET || '')
    .trim()
    .toLowerCase();
  if (override === 'local' || override === 'linked') return override;

  const envLocal = parseEnvFile(resolvePath(args.workdir, '.env.local'));
  const envFallback = parseEnvFile(resolvePath(args.workdir, '.env'));

  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.LOCAL_SUPABASE_URL ||
    envLocal.SUPABASE_URL ||
    envLocal.LOCAL_SUPABASE_URL ||
    envFallback.SUPABASE_URL ||
    envFallback.LOCAL_SUPABASE_URL;

  return isLocalSupabaseUrl(supabaseUrl) ? 'local' : 'linked';
}

// `supabase migration list` prints a table, whatever -o says (that flag
// formats status variables, not this listing):
//
//    Local          | Remote         | Time (UTC)
//   ----------------|----------------|---------------------
//    20260101000000 | 20260101000000 | 2026-01-01 00:00:00
//    20260915211657 |                | 2026-09-15 21:16:57   <- pending here
//                   | 20260916020035 | 2026-09-16 02:00:35   <- applied from another checkout
//
// A row with a local version and no remote one is pending in this checkout.
// A row with a remote version and no local one was applied from a checkout
// that has a file this one lacks, normally a branch that has not merged; it
// is reported, but it is not ours to apply and it does not make the run red.
//
// The header line is the proof that this is the listing at all. Output with
// no header (an error the CLI printed to stdout, a future format) is reported
// as unknown, never as clean: a clean answer is only ever "the table was
// there and no row was local-only".
function parseMigrationTable(raw) {
  const lines = String(raw).split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*Local\s*\|\s*Remote\s*\|/.test(line));
  if (header < 0) return null;
  const rows = [];
  for (const line of lines.slice(header + 1)) {
    const match = line.match(/^\s*(\d{14})?\s*\|\s*(\d{14})?\s*\|/);
    if (!match || (!match[1] && !match[2])) continue;
    rows.push({ local: match[1] || null, remote: match[2] || null });
  }
  return rows;
}

// The apply hint follows the target. `yarn db:migrate` only ever writes to
// the local stack; a pending linked listing keeps the linked apply path.
function applyHint(target) {
  return target === 'local'
    ? 'Run: yarn db:migrate supabase/migrations/<file> (one per pending version)'
    : 'Run: yarn linked:migrate';
}

function printHuman(result) {
  const scope = result.target === 'local' ? 'local' : 'linked';
  if (result.target) {
    console.log(`[migrations] Target: ${result.target}`);
  }
  if (result.state === 'unknown') {
    console.log(`[migrations] ⚠ Unable to determine ${scope} migration status: ${result.reason}`);
    return;
  }
  if (result.elsewhereCount > 0) {
    const shown = result.elsewhere.slice(0, 5).join(', ');
    const more = result.elsewhereCount > 5 ? `, +${result.elsewhereCount - 5} more` : '';
    console.log(
      `[migrations] ${result.elsewhereCount} applied from another checkout (a branch not merged here): ${shown}${more}`
    );
  }
  if (result.state === 'clean') {
    console.log(`[migrations] ✅ No pending ${scope} migrations.`);
    return;
  }
  console.log(
    `[migrations] ⚠ ${result.pendingCount} pending ${scope} migration${
      result.pendingCount === 1 ? '' : 's'
    }.`
  );
  for (const item of result.pending.slice(0, 10)) {
    console.log(`[migrations]   - ${item}`);
  }
  console.log(`[migrations] ${applyHint(result.target)}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args);
  if (args.printTarget) {
    console.log(target);
    process.exit(0);
    return;
  }

  const commandArgs = ['migration', 'list', `--${target}`, '--workdir', args.workdir];

  let raw;
  try {
    raw = execFileSync('supabase', commandArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' ? String(error.stderr || '').trim() : '';
    const stdout = error && typeof error === 'object' ? String(error.stdout || '').trim() : '';
    const detail = stderr || stdout || (error instanceof Error ? error.message : String(error));
    const result = {
      target,
      state: 'unknown',
      reason: detail || 'supabase migration list failed',
      pendingCount: 0,
      pending: [],
      elsewhereCount: 0,
      elsewhere: [],
    };
    if (args.json) console.log(JSON.stringify(result));
    else if (!args.quiet) printHuman(result);
    process.exit(args.warnOnly ? 0 : 2);
    return;
  }

  const rows = parseMigrationTable(raw);
  if (rows === null) {
    const result = {
      target,
      state: 'unknown',
      reason: 'unrecognized `supabase migration list` output (no Local | Remote header)',
      pendingCount: 0,
      pending: [],
      elsewhereCount: 0,
      elsewhere: [],
    };
    if (args.json) console.log(JSON.stringify(result));
    else if (!args.quiet) printHuman(result);
    process.exit(args.warnOnly ? 0 : 2);
    return;
  }
  const pending = rows.filter((row) => row.local && !row.remote).map((row) => row.local);
  const elsewhere = rows.filter((row) => row.remote && !row.local).map((row) => row.remote);
  const result = {
    target,
    state: pending.length > 0 ? 'pending' : 'clean',
    reason: null,
    pendingCount: pending.length,
    pending,
    elsewhereCount: elsewhere.length,
    elsewhere,
  };

  if (args.json) {
    console.log(JSON.stringify(result));
  } else if (!args.quiet) {
    printHuman(result);
  }

  if (args.warnOnly) {
    process.exit(0);
    return;
  }
  process.exit(result.state === 'pending' ? 10 : 0);
}

main();

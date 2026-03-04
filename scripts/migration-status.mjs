#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { resolve as resolvePath } from 'path';

function parseArgs(argv) {
  const args = {
    workdir: process.cwd(),
    json: false,
    warnOnly: false,
    quiet: false,
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
  }

  return args;
}

function boolLike(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  if (
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'present' ||
    normalized === 'applied'
  ) {
    return true;
  }
  if (
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'missing' ||
    normalized === 'not applied'
  ) {
    return false;
  }

  if (normalized.includes('not applied') || normalized.includes('missing')) return false;
  if (normalized.includes('applied') || normalized.includes('present')) return true;
  return undefined;
}

function rowLabel(row) {
  return (
    row.version ||
    row.name ||
    row.id ||
    row.filename ||
    row.file ||
    row.migration ||
    '(unknown)'
  );
}

function collectRows(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, out);
    return out;
  }

  if (!node || typeof node !== 'object') return out;
  const record = node;

  const hasMigrationShape =
    'version' in record ||
    'name' in record ||
    'migration' in record ||
    'local' in record ||
    'remote' in record ||
    'applied' in record;

  if (hasMigrationShape) out.push(record);

  for (const value of Object.values(record)) collectRows(value, out);
  return out;
}

function classifyPending(rows) {
  const pending = [];

  for (const row of rows) {
    const local = boolLike(row.local ?? row.localExists ?? row.existsLocal);
    const remote = boolLike(row.remote ?? row.remoteExists ?? row.existsRemote ?? row.applied);

    if (local === true && remote === false) {
      pending.push(row);
      continue;
    }

    const statusText = String(row.status || row.state || '').toLowerCase();
    if (
      statusText.includes('pending') ||
      statusText.includes('local only') ||
      statusText.includes('not applied')
    ) {
      pending.push(row);
    }
  }

  return pending;
}

function printHuman(result) {
  if (result.state === 'clean') {
    console.log('[migrations] ✅ No pending linked migrations.');
    return;
  }

  if (result.state === 'pending') {
    console.log(
      `[migrations] ⚠ ${result.pendingCount} pending linked migration${
        result.pendingCount === 1 ? '' : 's'
      }.`
    );
    for (const item of result.pending.slice(0, 10)) {
      console.log(`[migrations]   - ${item}`);
    }
    console.log('[migrations] Run: yarn prod:migrate');
    return;
  }

  console.log(`[migrations] ⚠ Unable to determine linked migration status: ${result.reason}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const commandArgs = ['migration', 'list', '--linked', '--workdir', args.workdir, '-o', 'json'];

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
      state: 'unknown',
      reason: detail || 'supabase migration list failed',
      pendingCount: 0,
      pending: [],
    };
    if (args.json) console.log(JSON.stringify(result));
    else if (!args.quiet) printHuman(result);
    process.exit(args.warnOnly ? 0 : 2);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const result = {
      state: 'unknown',
      reason: `Could not parse Supabase migration JSON output: ${
        error instanceof Error ? error.message : String(error)
      }`,
      pendingCount: 0,
      pending: [],
    };
    if (args.json) console.log(JSON.stringify(result));
    else if (!args.quiet) printHuman(result);
    process.exit(args.warnOnly ? 0 : 2);
    return;
  }

  const rows = collectRows(parsed);
  const pendingRows = classifyPending(rows);
  const result =
    pendingRows.length > 0
      ? {
          state: 'pending',
          reason: null,
          pendingCount: pendingRows.length,
          pending: pendingRows.map(rowLabel),
        }
      : {
          state: 'clean',
          reason: null,
          pendingCount: 0,
          pending: [],
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

#!/usr/bin/env node

/**
 * Wait for new review/comment activity on a GitHub PR.
 *
 * Usage:
 *   node scripts/wait-pr-reply.mjs <prNumber> [--repo owner/repo] [--timeout 120] [--interval 10]
 *   yarn pr:wait-reply <prNumber> --repo owner/repo --timeout 120 --interval 10
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(message) {
  if (message) {
    console.error(`Error: ${message}\n`);
  }
  console.error(`Usage:
  yarn pr:wait-reply <prNumber> [--repo owner/repo] [--timeout 120] [--interval 10]

Options:
  --repo      GitHub repo in owner/name form (optional if cwd is inside repo)
  --timeout   Max wait time in seconds (default: 120)
  --interval  Poll interval in seconds (default: 10)
  --since     ISO timestamp baseline (default: now)
`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const args = {
    prNumber: undefined,
    repo: undefined,
    timeoutSec: 120,
    intervalSec: 10,
    sinceIso: undefined,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const next = argv[i + 1];
    if (!next) {
      usage(`Missing value for ${arg}`);
      process.exit(2);
    }

    switch (arg) {
      case '--repo':
        args.repo = next;
        i += 1;
        break;
      case '--timeout':
        args.timeoutSec = Number(next);
        i += 1;
        break;
      case '--interval':
        args.intervalSec = Number(next);
        i += 1;
        break;
      case '--since':
        args.sinceIso = next;
        i += 1;
        break;
      default:
        usage(`Unknown option ${arg}`);
        process.exit(2);
    }
  }

  if (positional.length < 1) {
    usage('Missing required <prNumber>');
    process.exit(2);
  }

  args.prNumber = Number(positional[0]);
  if (!Number.isInteger(args.prNumber) || args.prNumber <= 0) {
    usage(`Invalid PR number: ${positional[0]}`);
    process.exit(2);
  }

  if (!Number.isFinite(args.timeoutSec) || args.timeoutSec <= 0) {
    usage(`Invalid --timeout value: ${args.timeoutSec}`);
    process.exit(2);
  }

  if (!Number.isFinite(args.intervalSec) || args.intervalSec <= 0) {
    usage(`Invalid --interval value: ${args.intervalSec}`);
    process.exit(2);
  }

  if (args.sinceIso && Number.isNaN(Date.parse(args.sinceIso))) {
    usage(`Invalid --since ISO timestamp: ${args.sinceIso}`);
    process.exit(2);
  }

  return args;
}

function extractTimestamp(entry) {
  const candidates = [
    entry?.submittedAt,
    entry?.updatedAt,
    entry?.createdAt,
    entry?.publishedAt,
  ].filter(Boolean);

  const parsed = candidates
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  return parsed[0] ?? 0;
}

async function fetchPrSnapshot(prNumber, repo) {
  const args = ['pr', 'view', String(prNumber), '--json', 'number,url,state,updatedAt,reviews,comments'];
  if (repo) {
    args.push('--repo', repo);
  }

  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 5 * 1024 * 1024 });
  const data = JSON.parse(stdout);

  const reviewList = Array.isArray(data.reviews) ? data.reviews : [];
  const commentList = Array.isArray(data.comments) ? data.comments : [];

  const latestReviewTs = Math.max(0, ...reviewList.map(extractTimestamp));
  const latestCommentTs = Math.max(0, ...commentList.map(extractTimestamp));
  const updatedTs = Number.isFinite(Date.parse(data.updatedAt)) ? Date.parse(data.updatedAt) : 0;
  const latestTs = Math.max(updatedTs, latestReviewTs, latestCommentTs);

  return {
    number: data.number,
    url: data.url,
    state: data.state,
    updatedAt: data.updatedAt,
    reviewCount: reviewList.length,
    commentCount: commentList.length,
    latestTs,
  };
}

function describeDelta(current, baseline) {
  const reviewsDelta = current.reviewCount - baseline.reviewCount;
  const commentsDelta = current.commentCount - baseline.commentCount;
  return `reviews +${Math.max(0, reviewsDelta)}, comments +${Math.max(0, commentsDelta)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineSince = args.sinceIso ? Date.parse(args.sinceIso) : Date.now();

  const baseline = await fetchPrSnapshot(args.prNumber, args.repo);
  const baselineTs = Math.max(baseline.latestTs, baselineSince);
  const deadline = Date.now() + args.timeoutSec * 1000;

  console.log(
    `[wait-pr-reply] Watching PR #${baseline.number} (${baseline.url}) for new activity after ${new Date(
      baselineTs
    ).toISOString()}`
  );
  console.log(
    `[wait-pr-reply] Initial state=${baseline.state}, reviews=${baseline.reviewCount}, comments=${baseline.commentCount}`
  );

  while (Date.now() < deadline) {
    await sleep(args.intervalSec * 1000);
    const current = await fetchPrSnapshot(args.prNumber, args.repo);

    const hasNewCounts =
      current.reviewCount > baseline.reviewCount || current.commentCount > baseline.commentCount;
    const hasNewTimestamp = current.latestTs > baselineTs;

    if (hasNewCounts || hasNewTimestamp) {
      console.log(
        `[wait-pr-reply] New activity detected: ${describeDelta(current, baseline)}; latest=${new Date(
          current.latestTs
        ).toISOString()}`
      );
      process.exit(0);
    }

    if (current.state && current.state !== 'OPEN') {
      console.log(
        `[wait-pr-reply] PR state is ${current.state} with no new review/comment activity. Stopping wait.`
      );
      process.exit(3);
    }

    console.log('[wait-pr-reply] No new activity yet...');
  }

  console.error(`[wait-pr-reply] Timed out after ${args.timeoutSec}s with no new activity.`);
  process.exit(1);
}

main().catch((error) => {
  console.error('[wait-pr-reply] Failed:', error?.message || String(error));
  process.exit(2);
});

/**
 * Readability on a fetched page, in a worker thread with a time budget.
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger),
 * extensions/web-readability/web-content-extractor.ts at commit f88e1f4c1c:
 * its two guards before Readability runs at all (READABILITY_MAX_HTML_CHARS
 * and the estimated nesting depth, with exceedsEstimatedHtmlNestingDepth as
 * written there), and running Readability on the page with hidden elements
 * removed first. The pass itself is readability-worker.mjs.
 *
 * OpenClaw runs Readability on its own thread. This server is one thread for
 * every request, and Readability's cost on a hostile page isn't linear, so
 * here it runs in a worker the server can stop:
 * - a wall-clock budget, after which the worker is terminated;
 * - a V8 heap ceiling, past which the worker dies on its own;
 * - at most MAX_CONCURRENT workers at once, so a burst of fetches can't
 *   multiply that ceiling.
 * Any of those, or a page Readability finds nothing in, gives an outcome
 * other than `read`, and the caller reads the page with the scan
 * (extract.ts) as it did before. This never throws.
 */

import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { stripHiddenHtml } from './extract';

export interface ReadabilityLimits {
  /** Wall-clock budget for the whole pass, the worker's start included. */
  budgetMs: number;
  /** OpenClaw's READABILITY_MAX_HTML_CHARS: a longer page skips Readability. */
  maxHtmlChars: number;
  /** OpenClaw's READABILITY_MAX_ESTIMATED_NESTING_DEPTH. */
  maxNestingDepth: number;
  /** The worker's old-generation heap ceiling, in MB. */
  maxHeapMb: number;
}

export const READABILITY_LIMITS: Readonly<ReadabilityLimits> = {
  budgetMs: 3_000,
  maxHtmlChars: 1_000_000,
  maxNestingDepth: 3_000,
  maxHeapMb: 256,
};

/** Workers that may run at once; a call past this reads the page with the scan. */
export const MAX_CONCURRENT = 2;

export type ReadabilityOutcome =
  | { kind: 'read'; content: string; title?: string }
  | { kind: 'skipped'; reason: 'too-large' | 'too-deep' | 'busy' }
  | { kind: 'failed'; reason: 'timeout' | 'error' | 'exit' | 'empty' };

const WORKER_FILE = join(__dirname, 'readability-worker.mjs');

let active = 0;

/** Workers running now. For tests and the measurements in the PR. */
export function activeReadabilityWorkers(): number {
  return active;
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Whether the page nests deeper than `maxDepth`, estimated from its tags
 * alone in one pass. OpenClaw's function, as written there.
 */
export function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  let depth = 0;
  const len = html.length;
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) {
      continue;
    }
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) {
      continue;
    }

    let j = i + 1;
    let closing = false;
    if (html.charCodeAt(j) === 47) {
      closing = true;
      j += 1;
    }

    while (j < len && html.charCodeAt(j) <= 32) {
      j += 1;
    }

    const nameStart = j;
    while (j < len) {
      const c = html.charCodeAt(j);
      const isNameChar =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 58 ||
        c === 45;
      if (!isNameChar) {
        break;
      }
      j += 1;
    }

    const tagName = html.slice(nameStart, j).trim().toLowerCase();
    if (!tagName) {
      continue;
    }

    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (VOID_TAGS.has(tagName)) {
      continue;
    }

    let selfClosing = false;
    for (let k = j; k < len && k < j + 200; k++) {
      const c = html.charCodeAt(k);
      if (c === 62) {
        selfClosing = html.charCodeAt(k - 1) === 47;
        break;
      }
    }
    if (selfClosing) {
      continue;
    }

    depth += 1;
    if (depth > maxDepth) {
      return true;
    }
  }
  return false;
}

/**
 * Readability's main content for a page: its HTML and title, or why there is
 * none. The page is stripped of hidden elements before the guards and the
 * worker see it.
 */
export function readMainContent(
  html: string,
  url: string,
  limits: Readonly<ReadabilityLimits> = READABILITY_LIMITS
): Promise<ReadabilityOutcome> {
  const clean = stripHiddenHtml(html);
  if (clean.length > limits.maxHtmlChars) {
    return Promise.resolve({ kind: 'skipped', reason: 'too-large' });
  }
  if (exceedsEstimatedHtmlNestingDepth(clean, limits.maxNestingDepth)) {
    return Promise.resolve({ kind: 'skipped', reason: 'too-deep' });
  }
  if (active >= MAX_CONCURRENT) {
    return Promise.resolve({ kind: 'skipped', reason: 'busy' });
  }

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: { html: clean, url },
        resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb },
      });
    } catch {
      resolve({ kind: 'failed', reason: 'error' });
      return;
    }
    active += 1;
    let settled = false;
    const finish = (outcome: ReadabilityOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active -= 1;
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'failed', reason: 'timeout' }), limits.budgetMs);
    worker.once('message', (message: unknown) => {
      const read = message as { content?: unknown; title?: unknown } | null;
      if (read && typeof read.content === 'string' && read.content) {
        finish({
          kind: 'read',
          content: read.content,
          ...(typeof read.title === 'string' && read.title ? { title: read.title } : {}),
        });
      } else {
        finish({ kind: 'failed', reason: 'empty' });
      }
    });
    worker.once('error', () => finish({ kind: 'failed', reason: 'error' }));
    worker.once('exit', () => finish({ kind: 'failed', reason: 'exit' }));
  });
}

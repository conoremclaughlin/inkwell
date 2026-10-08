/**
 * Readability's pass over one page, in a worker thread (readability.ts).
 *
 * Ported from OpenClaw (MIT License, Copyright (c) 2025 Peter Steinberger),
 * extensions/web-readability/web-content-extractor.ts at commit f88e1f4c1c:
 * linkedom's parseHTML, the page's URL as the document's base, and
 * Readability with charThreshold 0. What differs: this runs in a worker the
 * server can stop, it receives HTML already stripped of hidden elements by
 * stripHiddenHtml, and it hands back Readability's HTML for the server's own
 * linear converter, where OpenClaw converts with expressions of its own.
 *
 * Plain JavaScript, because a worker thread loads a file as it is: the build
 * copies it beside the compiled readability.js.
 *
 * Posts { content, title } when Readability finds content, null when it
 * doesn't, and null when anything throws. Never posts the page back.
 */

import { parentPort, workerData } from 'node:worker_threads';
import readabilityModule from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const { Readability } = readabilityModule;

function read({ html, url }) {
  const { document } = parseHTML(html);
  try {
    document.baseURI = url;
  } catch {
    // Best-effort base URI for relative links.
  }
  const parsed = new Readability(document, { charThreshold: 0 }).parse();
  if (!parsed?.content) return null;
  return { content: parsed.content, title: parsed.title || undefined };
}

let result = null;
try {
  result = read(workerData);
} catch {
  result = null;
}
parentPort.postMessage(result);

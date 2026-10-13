import type { RetainedImageDescriptor } from './context-media.js';
/**
 * A tool-returned image owned by a context entry. Hosts cache and deliver the
 * bytes; the runtime only retains this structural descriptor and its cost.
 * Compatible with provider media without importing providers or host I/O.
 */
export interface ContextImage {
  /** `img:` plus a content hash: the name the model and the ledger use. */
  ref: string;
  /** Verified log-owned retention, absent for ephemeral delivery. Never persist path. */
  retained?: RetainedImageDescriptor;
  /** The host's cached copy. Never shown to the model. */
  path: string;
  mimeType: string;
  width: number;
  height: number;
  /** Estimated input tokens (width × height ÷ 750, Anthropic's published rule). */
  approxTokens: number;
}

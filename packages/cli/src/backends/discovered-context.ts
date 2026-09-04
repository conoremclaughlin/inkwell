import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import type { HiddenContextEstimate } from './types.js';

/** A reserve for the tool schemas a CLI registers with the model. */
export const TOOL_SCHEMA_RESERVE_BYTES = 8 * 1024;

/**
 * Sum the sizes of `fileName` from the repository root (the nearest ancestor
 * holding `.git`, or the filesystem root) down to `cwd`, the way Codex and
 * Gemini concatenate their instruction files, capped at `maxBytes` when the
 * CLI caps its own reading.
 */
export function discoveredInstructionBytes(
  cwd: string,
  fileName: string,
  maxBytes: number = Number.POSITIVE_INFINITY
): HiddenContextEstimate {
  const chain: string[] = [];
  let dir = cwd;
  for (;;) {
    chain.unshift(dir);
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let bytes = 0;
  const found: string[] = [];
  for (const d of chain) {
    const f = join(d, fileName);
    try {
      const st = statSync(f);
      if (st.isFile()) {
        bytes += st.size;
        found.push(f);
      }
    } catch {
      // absent
    }
  }
  const capped = Math.min(bytes, maxBytes);
  return {
    bytes: capped,
    detail: found.length
      ? `${fileName} × ${found.length} (${bytes.toLocaleString()} bytes${capped < bytes ? `, capped at ${maxBytes.toLocaleString()}` : ''})`
      : `no ${fileName}`,
  };
}

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { onceAsync } from './once-async.js';

describe('onceAsync', () => {
  it('gives a caller that arrives mid-run the same pending completion', async () => {
    let finish!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const ensure = onceAsync(work);

    let firstDone = false;
    let secondDone = false;
    const first = ensure().then(() => {
      firstDone = true;
    });
    // The second caller (a close after an error, say) arrives while the
    // first removal is still running.
    const second = ensure().then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(work).toHaveBeenCalledTimes(1);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    finish();
    await Promise.all([first, second]);
    expect(firstDone && secondDone).toBe(true);
    // A later call does not start the work again.
    await ensure();
    expect(work).toHaveBeenCalledTimes(1);
  });
});

// The launcher's close and error handlers both await ensureCleanup and then
// may exit; each must wait for the one removal, not return on a flag.
describe('ink claude launcher cleanup', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'commands', 'claude.ts'),
    'utf8'
  );

  it('shares one in-flight cleanup between its callers', () => {
    expect(source).toMatch(
      /const ensureCleanup = onceAsync\(\s*\(\) => prepared\.cleanup\(\)\s*\)/
    );
    expect(source).not.toMatch(/\bcleanedUp\b/);
  });
});

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureInklingFolder,
  inklingFolder,
  inklingToolPolicyPath,
  inklingsRoot,
} from './inkling-folder';

const SB = '3f1c2b7a-9d4e-4c1a-8b2f-6e5d4c3b2a10';
const CHECKOUT = resolve(__dirname, '../../../../..');

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'inkling-folder-'));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('an inkling folder', () => {
  it('lives under ~/.ink/inklings/<sbId>, never in the Inkwell checkout', () => {
    expect(inklingsRoot('/home/someone')).toBe('/home/someone/.ink/inklings');
    const folder = inklingFolder(SB);
    expect(folder.endsWith(join('.ink', 'inklings', SB))).toBe(true);
    expect(folder.startsWith(CHECKOUT + '/')).toBe(false);
  });

  it('takes only an identity id: nothing else chooses the path', () => {
    for (const bad of ['../../etc', 'kindle-abc', '', `${SB}/..`, '.']) {
      expect(() => inklingFolder(bad, scratch), bad).toThrow(/identity id/);
    }
    expect(inklingFolder(SB.toUpperCase(), scratch)).toBe(join(scratch, SB));
  });

  it('is made the first time it is needed, and reused after', async () => {
    const folder = await ensureInklingFolder(SB, scratch);
    expect((await stat(folder)).isDirectory()).toBe(true);
    expect(await ensureInklingFolder(SB, scratch)).toBe(folder);
  });
});

describe("an inkling's tool policy file (task 0321ccf1)", () => {
  it("sits beside the inklings' folders, never inside its own, named by its id", () => {
    const root = join(scratch, 'inklings');
    const policy = inklingToolPolicyPath(SB.toUpperCase(), root);
    expect(policy).toBe(join(root, '.tool-policy', `${SB}.json`));
    expect(policy.startsWith(inklingFolder(SB, root) + '/')).toBe(false);
  });

  it('takes nothing but an identity id as its name', () => {
    for (const bad of ['', '../escape', 'kindle-1', `${SB}/x`]) {
      expect(() => inklingToolPolicyPath(bad, scratch), bad).toThrow(/identity id/);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { inklingsRoot } from '../inklings/inkling-folder';
import { inkStudiosRoot } from '../studio-paths';
import { defaultUploadsRoot, inkDataDir, prepareUploadsRoot } from './layout';
import { uploadsRootNeighbours } from './placement';

describe('uploadsRootNeighbours', () => {
  it('lists what is served, the studios root, the inklings’ folders and the checkout', () => {
    expect(uploadsRootNeighbours(['/srv/files', '/srv/shots'], '/repo')).toEqual([
      '/srv/files',
      '/srv/shots',
      inkStudiosRoot(),
      inklingsRoot(),
      '/repo',
    ]);
  });

  describe('at startup, under a home of its own', () => {
    let home: string;

    beforeEach(() => {
      home = realpathSync(mkdtempSync(join(tmpdir(), 'uploads-placement-')));
      vi.stubEnv('HOME', home);
      vi.stubEnv('INK_STUDIOS_ROOT', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });

    const served = () => [join(home, '.ink', 'files'), join(home, 'repo', 'docs', 'screenshots')];

    it('takes the default root', async () => {
      expect(
        await prepareUploadsRoot(
          defaultUploadsRoot(),
          inkDataDir(),
          uploadsRootNeighbours(served(), join(home, 'repo'))
        )
      ).toMatchObject({ ok: true, rootReal: join(home, '.ink', 'uploads') });
    });

    it('refuses a root among the studios or the inklings’ folders', async () => {
      for (const root of [
        join(home, '.ink', 'studios', 'uploads'),
        join(home, '.ink', 'inklings', 'uploads'),
      ]) {
        expect(
          await prepareUploadsRoot(
            root,
            inkDataDir(),
            uploadsRootNeighbours(served(), join(home, 'repo'))
          ),
          root
        ).toMatchObject({ ok: false, reason: 'overlaps' });
      }
    });

    it('refuses when a turn’s default working directory would hold the root', async () => {
      expect(
        await prepareUploadsRoot(
          defaultUploadsRoot(),
          inkDataDir(),
          uploadsRootNeighbours([], home)
        )
      ).toMatchObject({ ok: false, reason: 'overlaps' });
    });
  });
});

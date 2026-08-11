/**
 * Absolute path to the CLI entrypoint, for tests that spawn the real binary.
 *
 * Resolved from import.meta.url rather than written relative to the repo root:
 * root-level Vitest runs with cwd at the repo root, but
 * `yarn workspace @inklabs/cli test` runs with cwd at packages/cli, where a
 * literal 'packages/cli/src/cli.ts' resolves to packages/cli/packages/cli/...
 * and every spawn fails.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** packages/cli/src/cli.ts, valid from any working directory. */
export const CLI_ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');

/** CLI compatibility path; provider preparation stays asynchronous in shared. */
import { resolveChannelPluginPath as resolveSharedChannelPluginPath } from '@inklabs/shared/providers';
import { inkCliMainWorktree } from './ink-checkout.js';

export {
  parseSkillMcpConfig,
  discoverSkillMcpServers,
  buildMergedMcpConfig,
  type SkillMcpServer,
} from '@inklabs/shared/providers';

/** `ink init` uses the same candidates as the CLI provider host. */
export function resolveChannelPluginPath(cwd: string): string | null {
  return resolveSharedChannelPluginPath(cwd, inkCliMainWorktree() ?? undefined);
}

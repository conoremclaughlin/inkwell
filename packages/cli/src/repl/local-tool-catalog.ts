/** CLI host adapter for the shared runtime discovery surface. */
import {
  describeLocalTool as describeSharedLocalTool,
  describeToolWithLocalSurface as describeSharedSurface,
  type LocalToolEntry,
  type DescribeToolLocalOptions as SharedOptions,
} from '@inklabs/shared/runtime';
import { initPiTools } from './pi-tools.js';
export {
  LOCAL_TOOL_CATALOG,
  listLocalTools,
  findLocalTool,
  renderLocalToolLine,
  renderLocalToolGroup,
  isLocalRuntimeTool,
  type LocalToolGroup,
  type LocalToolAudience,
  type LocalToolEntry,
  type LocalToolDescription,
} from '@inklabs/shared/runtime';
export type DescribeToolLocalOptions = Omit<SharedOptions, 'loadCodingTools'>;
export const describeLocalTool = (entry: LocalToolEntry, cwd: string) =>
  describeSharedLocalTool(entry, cwd, initPiTools);
export const describeToolWithLocalSurface = (
  args: Record<string, unknown>,
  opts: DescribeToolLocalOptions
) => describeSharedSurface(args, { ...opts, loadCodingTools: initPiTools });

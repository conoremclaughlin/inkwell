/** CLI effects for the shared tool dispatcher. */
import {
  createLocalToolDispatcher as createSharedDispatcher,
  type LocalToolDispatchDeps as SharedDeps,
} from '@inklabs/shared/runtime';
import { initPiTools } from './pi-tools.js';
import { viewImage } from './view-image.js';
export {
  bareToolName,
  impossibleCallRefusal,
  miscasedPiToolCorrection,
  type ToolDispatchContext,
  type LocalToolDispatcher,
} from '@inklabs/shared/runtime';
export type LocalToolDispatchDeps = Omit<SharedDeps, 'loadCodingTools' | 'viewImage'> & {
  viewImage?: SharedDeps['viewImage'];
};
export function createLocalToolDispatcher(deps: LocalToolDispatchDeps) {
  return createSharedDispatcher({
    ...deps,
    loadCodingTools: initPiTools,
    viewImage: deps.viewImage ?? ((args, cwd, signal) => viewImage(args, { cwd, signal })),
  });
}

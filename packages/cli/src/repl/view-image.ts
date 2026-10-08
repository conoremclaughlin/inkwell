/** CLI defaults around the same async, explicitly scoped image implementation as the server. */
import { homedir } from 'os';
import { join } from 'path';
import {
  viewImage as sharedViewImage,
  type ViewImageOptions as SharedOptions,
} from '@inklabs/shared/node-host';
import { initPiTools } from './pi-tools.js';
export {
  MAX_VIEW_IMAGE_FILE_BYTES,
  VIEW_IMAGE_TOOL,
  type ImageReader,
} from '@inklabs/shared/node-host';
export interface ViewImageOptions extends Omit<SharedOptions, 'home' | 'roots' | 'readImage'> {
  roots?: string[];
  readImage?: SharedOptions['readImage'];
}
export function viewImageRoots(cwd: string): string[] {
  return [cwd, join(homedir(), '.ink', 'files')];
}
export function viewImage(args: Record<string, unknown>, opts: ViewImageOptions) {
  return sharedViewImage(args, {
    ...opts,
    home: homedir(),
    roots: opts.roots ?? viewImageRoots(opts.cwd),
    readImage:
      opts.readImage ??
      (async (path, signal) => {
        const read = (await initPiTools(opts.cwd)).get('read');
        if (!read) throw new Error('Pi read tool is unavailable');
        const result = await read.execute(`pi-view-image-${Date.now()}`, { path }, signal);
        return { content: result.content, success: true };
      }),
  });
}

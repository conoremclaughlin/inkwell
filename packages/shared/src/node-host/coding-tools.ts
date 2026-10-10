/** The CLI's coding-tool adapter, with a private cache and explicit host effects. */
import { validatePathArgsAsync } from '../security/path-containment.js';
import type { InkToolCallResult } from '../runtime/tool-result.js';

export interface CodingTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

export interface CodingToolHostPorts {
  /** Create the existing Pi tools for this directory; never a global current cwd. */
  load(cwd: string): Promise<ReadonlyMap<string, CodingTool>>;
  /** PDF handling is supplied by the host, not run on the server event loop. */
  readDocument(path: string, cwd: string, signal?: AbortSignal): Promise<InkToolCallResult | null>;
}

export function createCodingToolHost(cwd: string, ports: CodingToolHostPorts) {
  let cached: Promise<ReadonlyMap<string, CodingTool>> | undefined;
  const tools = () => {
    cached ??= ports.load(cwd).catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
  return {
    tools,
    async call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const tool = (await tools()).get(toolName);
      if (!tool) throw new Error(`Pi tool "${toolName}" not found`);
      await validatePathArgsAsync(toolName, args, cwd);
      signal?.throwIfAborted();
      if (toolName === 'read') {
        const path = args.path ?? args.file_path ?? args.filePath;
        if (typeof path === 'string' && path) {
          const doc = await ports.readDocument(path, cwd, signal);
          signal?.throwIfAborted();
          if (doc) return doc;
        }
      }
      const result = await tool.execute(`pi-${toolName}-${Date.now()}`, args, signal);
      return {
        content: result.content,
        text: result.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n'),
        success: true,
      } as InkToolCallResult;
    },
    async readImage(path: string, signal?: AbortSignal): Promise<InkToolCallResult> {
      // viewImage has already validated its additional attachment roots.
      signal?.throwIfAborted();
      const read = (await tools()).get('read');
      signal?.throwIfAborted();
      if (!read) throw new Error('Pi read tool is unavailable');
      const result = await read.execute(`pi-view-image-${Date.now()}`, { path }, signal);
      return { content: result.content, success: true };
    },
  };
}

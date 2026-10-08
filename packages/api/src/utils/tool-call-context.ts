/**
 * Which MCP tool the current async call is running inside.
 *
 * registerAllTools runs every tool handler inside runInToolCall, so code far
 * below a handler (a service fetching a connected account's token, say) can
 * ask what tool it is serving without every layer passing the name down.
 * Outside a tool call (background work, a web route) there is no name.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const toolCalls = new AsyncLocalStorage<{ toolName: string }>();

export function runInToolCall<T>(toolName: string, run: () => T): T {
  return toolCalls.run({ toolName }, run);
}

/** The tool the current call is running inside, or undefined outside one. */
export function currentToolName(): string | undefined {
  return toolCalls.getStore()?.toolName;
}

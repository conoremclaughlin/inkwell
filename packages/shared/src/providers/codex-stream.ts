/**
 * `codex exec --json` emits completed items and a terminal turn result.
 * This is an output adapter, not a native-tool enforcement boundary: native
 * activity can be reported after it happened, and not every tool is visible.
 * https://learn.chatgpt.com/docs/non-interactive-mode
 */
import { extractBackendTokenUsage } from '../runtime/token-usage.js';
import type { BackendMessageSource, BackendStreamParser, BackendTurnEvent } from './stream.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// A native command or patch can carry substantial output, but an unfinished
// frame must not grow without limit. This bounds THIS parser's frame buffer,
// not spawnBackend's separate raw-stdout capture.
const MAX_EVENT_BYTES = 4 * 1024 * 1024;

export class CodexStreamParser implements BackendStreamParser {
  private buffer = '';
  private bufferBytes = 0;
  private lastAssistantText = '';
  private lastAssistantSource: BackendMessageSource | undefined;
  private completedMessages = new Set<string>();
  private finished = false;

  push(chunk: string): BackendTurnEvent[] {
    if (this.finished) return [];
    const out: BackendTurnEvent[] = [];
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf('\n', cursor);
      const fragment = chunk.slice(cursor, newline === -1 ? undefined : newline);
      const bytes = Buffer.byteLength(fragment, 'utf8');
      if (this.bufferBytes + bytes > MAX_EVENT_BYTES) {
        this.buffer = '';
        this.bufferBytes = 0;
        this.fail(`Codex event exceeded the ${MAX_EVENT_BYTES}-byte limit.`, out);
        return out;
      }
      this.buffer += fragment;
      this.bufferBytes += bytes;
      if (newline === -1) break;
      this.consume(this.buffer, out);
      this.buffer = '';
      this.bufferBytes = 0;
      if (this.finished) return out;
      cursor = newline + 1;
    }
    return out;
  }

  end(): BackendTurnEvent[] {
    const out: BackendTurnEvent[] = [];
    if (this.buffer.trim()) this.consume(this.buffer, out);
    this.buffer = '';
    this.bufferBytes = 0;
    if (!this.finished) this.fail('Codex stream ended before turn completion.', out);
    return out;
  }

  private fail(error: string, out: BackendTurnEvent[]): void {
    this.finished = true;
    // Explicit empty text prevents progress from becoming a successful-looking
    // final reply or an ink tool request after a failed provider turn.
    out.push({ kind: 'result', text: '', error });
  }

  private consume(line: string, out: BackendTurnEvent[]): void {
    if (this.finished || !line.trim()) return;
    let event: Record<string, unknown> | undefined;
    try {
      event = object(JSON.parse(line));
    } catch {
      return; // Ignore startup chrome; a terminal frame is still mandatory.
    }
    if (!event) return;
    if (event.type === 'turn.failed') {
      const message = object(event.error)?.message;
      this.fail(typeof message === 'string' && message ? message : 'Codex turn failed.', out);
      return;
    }
    if (event.type === 'turn.completed') {
      this.finished = true;
      const usage = extractBackendTokenUsage('codex', JSON.stringify(event), '');
      out.push({
        kind: 'result',
        text: this.lastAssistantText,
        ...(this.lastAssistantSource ? { source: this.lastAssistantSource } : {}),
        ...(usage ? { usage } : {}),
      });
      return;
    }
    // `error` can describe a reconnect attempt, not a terminal failure.
    // Only turn.failed or EOF without completion ends a turn unsuccessfully.
    const item = object(event.item);
    if (!item) return;
    if (event.type === 'item.completed' && item.type === 'agent_message') {
      if (typeof item.text === 'string') {
        // Exec's documented item shape provides identity but no origin marker.
        // Do not invent parent authority from that absence. Backend evidence
        // must establish origin before this adapter can authorize stream tools.
        const source: BackendMessageSource | undefined =
          typeof item.id === 'string' && item.id
            ? { messageId: item.id, origin: 'unknown' }
            : undefined;
        const repeated = source && this.completedMessages.has(source.messageId);
        if (!repeated) {
          this.lastAssistantText = item.text;
          this.lastAssistantSource = source;
        }
        if (source && !repeated)
          out.push({ kind: 'text-boundary', boundary: 'message-start', source });
        if (item.text)
          out.push({
            kind: 'text',
            text: item.text,
            ...(source ? { source: { ...source, blockId: source.messageId, offset: 0 } } : {}),
          });
        if (source) {
          out.push({ kind: 'text-boundary', boundary: 'message-end', source, complete: true });
          this.completedMessages.add(source.messageId);
        }
      }
      return;
    }
    const id = typeof item.id === 'string' ? item.id : undefined;
    const name =
      item.type === 'mcp_tool_call' &&
      typeof item.server === 'string' &&
      typeof item.tool === 'string'
        ? `mcp__${item.server}__${item.tool}`
        : item.type === 'command_execution'
          ? 'exec_command'
          : item.type === 'file_change'
            ? 'apply_patch'
            : item.type === 'web_search'
              ? 'web_search'
              : undefined;
    if (!name) return;
    if (event.type === 'item.started') {
      const input =
        item.type === 'mcp_tool_call'
          ? item.arguments
          : item.type === 'command_execution'
            ? { command: item.command }
            : item.type === 'web_search'
              ? { query: item.query }
              : undefined;
      out.push({ kind: 'tool-use', id, name, ...(input !== undefined ? { input } : {}) });
    } else if (event.type === 'item.completed') {
      out.push({
        kind: 'tool-result',
        id,
        isError:
          item.status === 'failed' ||
          (typeof item.exit_code === 'number' && item.exit_code !== 0) ||
          item.error != null,
      });
    }
  }
}

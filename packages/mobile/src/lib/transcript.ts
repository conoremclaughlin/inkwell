/**
 * Transcript events → conversation turns, for the session history screen.
 *
 * A port of packages/web/src/components/session-viewer/transcript-parser.ts
 * (kept in step by hand — the two render the same /sessions/:id/conversation
 * payload). Pure functions over untyped event arrays: each backend writes a
 * different JSONL shape and none of them is under our control, so every
 * access is defensive and unknown events are skipped, never thrown on.
 */

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  blocks: ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ToolCallBlock
  | ToolResultBlock
  | ThinkingBlock
  | SystemBlock;

export interface TextBlock {
  kind: 'text';
  text: string;
}

export interface ToolCallBlock {
  kind: 'tool-call';
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  kind: 'tool-result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ThinkingBlock {
  kind: 'thinking';
  text: string;
}

export interface SystemBlock {
  kind: 'system';
  text: string;
  subtype?: string;
}

// Claude Code JSONL event shapes
interface ClaudeEvent {
  type: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: (RawContentItem | string)[] | string;
    model?: string;
    stop_reason?: string;
  };
  attachment?: {
    type: string;
    content?: string;
    hookName?: string;
    [key: string]: unknown;
  };
  toolUseResult?: unknown;
  operation?: string;
  sessionId?: string;
  content?: string;
  lastPrompt?: string;
  [key: string]: unknown;
}

interface RawContentItem {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  thinking?: string;
  [key: string]: unknown;
}

function parseClaudeContentBlock(item: RawContentItem): ContentBlock | null {
  if (item.type === 'text') {
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text.trim()) return null;
    return { kind: 'text', text } satisfies TextBlock;
  }

  if (item.type === 'tool_use') {
    return {
      kind: 'tool-call',
      toolUseId: String(item.id ?? ''),
      name: String(item.name ?? 'unknown'),
      input: item.input,
    } satisfies ToolCallBlock;
  }

  if (item.type === 'tool_result') {
    let content: string;
    if (typeof item.content === 'string') {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      content = item.content
        .map((c: unknown) => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object' && 'text' in c)
            return String((c as Record<string, unknown>).text);
          return JSON.stringify(c);
        })
        .join('\n');
    } else {
      content = String(item.content ?? '');
    }
    return {
      kind: 'tool-result',
      toolUseId: String(item.tool_use_id ?? ''),
      content,
      isError: item.is_error === true,
    } satisfies ToolResultBlock;
  }

  if (item.type === 'thinking') {
    const thinking = typeof item.thinking === 'string' ? item.thinking : '';
    if (!thinking.trim()) return null;
    return { kind: 'thinking', text: thinking } satisfies ThinkingBlock;
  }

  return null;
}

export function parseClaudeTranscript(events: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let currentAssistantTurn: ConversationTurn | null = null;

  for (const raw of events) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = raw as ClaudeEvent;

    if (event.type === 'queue-operation' || event.type === 'last-prompt') continue;

    if (event.type === 'attachment') {
      const att = event.attachment;
      if (!att) continue;

      if (att.type === 'hook_success' || att.type === 'hook_error') {
        const hookContent = typeof att.content === 'string' ? att.content : '';
        if (hookContent.trim()) {
          turns.push({
            id: event.uuid ?? `sys-${turns.length}`,
            role: 'system',
            timestamp: event.timestamp ?? '',
            blocks: [
              {
                kind: 'system',
                text: hookContent.length > 500 ? hookContent.slice(0, 500) + '...' : hookContent,
                subtype: att.hookName ?? 'hook',
              } satisfies SystemBlock,
            ],
          });
        }
      }
      continue;
    }

    if (event.type === 'user') {
      currentAssistantTurn = null;
      const content = event.message?.content;
      if (!content) continue;

      const blocks: ContentBlock[] = [];

      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === 'string') {
            if (item.trim()) blocks.push({ kind: 'text', text: item });
            continue;
          }
          if (!item || typeof item !== 'object') continue;
          const parsed = parseClaudeContentBlock(item as RawContentItem);
          if (parsed) blocks.push(parsed);
        }
      } else if (typeof content === 'string') {
        if (content.trim()) blocks.push({ kind: 'text', text: content });
      }

      if (blocks.length === 0) continue;

      turns.push({
        id: event.uuid ?? `user-${turns.length}`,
        role: 'user',
        timestamp: event.timestamp ?? '',
        blocks,
      });
      continue;
    }

    if (event.type === 'assistant') {
      const content = event.message?.content;
      if (!content || !Array.isArray(content)) continue;

      const blocks: ContentBlock[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const parsed = parseClaudeContentBlock(item as RawContentItem);
        if (parsed) blocks.push(parsed);
      }

      if (blocks.length === 0) continue;

      if (currentAssistantTurn) {
        currentAssistantTurn.blocks.push(...blocks);
        currentAssistantTurn.timestamp = event.timestamp ?? currentAssistantTurn.timestamp;
      } else {
        currentAssistantTurn = {
          id: event.uuid ?? `asst-${turns.length}`,
          role: 'assistant',
          timestamp: event.timestamp ?? '',
          blocks,
        };
        turns.push(currentAssistantTurn);
      }
      continue;
    }
  }

  return turns;
}

export function parseCodexTranscript(events: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const raw of events) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;

    const type = String(event.type ?? event.role ?? '');
    const timestamp = String(event.timestamp ?? event.created_at ?? event.ts ?? '');

    if (type === 'user' || type === 'input') {
      const text = extractTextContent(event);
      if (text) {
        turns.push({
          id: String(event.id ?? `codex-user-${turns.length}`),
          role: 'user',
          timestamp,
          blocks: [{ kind: 'text', text }],
        });
      }
    } else if (type === 'assistant' || type === 'output' || type === 'response') {
      const blocks = extractContentBlocks(event);
      if (blocks.length > 0) {
        turns.push({
          id: String(event.id ?? `codex-asst-${turns.length}`),
          role: 'assistant',
          timestamp,
          blocks,
        });
      }
    }
  }

  return turns;
}

export function parseGeminiTranscript(events: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  if (!Array.isArray(events)) return turns;

  for (const raw of events) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;

    const role = String(event.role ?? event.author ?? '');
    const timestamp = String(event.timestamp ?? event.createTime ?? '');

    const parts = Array.isArray(event.parts) ? event.parts : [];
    const blocks: ContentBlock[] = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string' && p.text.trim()) {
        blocks.push({ kind: 'text', text: p.text });
      } else if (p.functionCall && typeof p.functionCall === 'object') {
        const fc = p.functionCall as Record<string, unknown>;
        blocks.push({
          kind: 'tool-call',
          toolUseId: String(fc.id ?? `gemini-tc-${turns.length}`),
          name: String(fc.name ?? 'unknown'),
          input: fc.args ?? {},
        });
      } else if (p.functionResponse && typeof p.functionResponse === 'object') {
        const fr = p.functionResponse as Record<string, unknown>;
        blocks.push({
          kind: 'tool-result',
          toolUseId: String(fr.id ?? ''),
          content:
            typeof fr.response === 'string' ? fr.response : JSON.stringify(fr.response ?? ''),
          isError: false,
        });
      }
    }

    if (blocks.length === 0) {
      const text = extractTextContent(event);
      if (text) blocks.push({ kind: 'text', text });
    }

    if (blocks.length > 0) {
      turns.push({
        id: String(event.id ?? `gemini-${turns.length}`),
        role: role === 'user' ? 'user' : role === 'model' ? 'assistant' : 'system',
        timestamp,
        blocks,
      });
    }
  }

  return turns;
}

function extractTextContent(event: Record<string, unknown>): string {
  if (typeof event.content === 'string') return event.content;
  if (typeof event.text === 'string') return event.text;
  if (typeof event.message === 'string') return event.message;
  if (event.message && typeof event.message === 'object') {
    const msg = event.message as Record<string, unknown>;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(
          (b): b is { text: string } =>
            b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
        )
        .map((b) => b.text)
        .join('\n');
    }
  }
  return '';
}

function extractContentBlocks(event: Record<string, unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const content = (event.message as Record<string, unknown> | undefined)?.content ?? event.content;

  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content });
    return blocks;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const ci = item as RawContentItem;
      const parsed = parseClaudeContentBlock(ci);
      if (parsed) blocks.push(parsed);
    }
  }

  return blocks;
}

export function parseInkTranscript(events: unknown[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const raw of events) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;

    const type = String(event.type ?? '');
    const direction = String(event.direction ?? '');
    const content = typeof event.content === 'string' ? event.content : '';
    const timestamp = String(event.timestamp ?? event.created_at ?? '');
    const id = String(event.id ?? `ink-${turns.length}`);

    if ((type === 'message_in' || type === 'message') && direction === 'in') {
      if (content.trim()) {
        turns.push({
          id,
          role: 'user',
          timestamp,
          blocks: [{ kind: 'text', text: content }],
        });
      }
      continue;
    }

    if ((type === 'message_out' || type === 'message') && direction === 'out') {
      if (content.trim()) {
        turns.push({
          id,
          role: 'assistant',
          timestamp,
          blocks: [{ kind: 'text', text: content }],
        });
      }
      continue;
    }

    if (type === 'agent_spawn' || type === 'agent_complete' || type === 'error') {
      const label =
        type === 'agent_spawn'
          ? 'session started'
          : type === 'agent_complete'
            ? 'session completed'
            : 'error';
      const detail = content.trim() ? `${label}: ${content.slice(0, 300)}` : label;
      turns.push({
        id,
        role: 'system',
        timestamp,
        blocks: [{ kind: 'system', text: detail, subtype: type }],
      });
      continue;
    }
  }

  return turns;
}

export function parseTranscript(backend: string, events: unknown[]): ConversationTurn[] {
  const b = backend.toLowerCase();
  if (b === 'ink') return parseInkTranscript(events);
  if (b.includes('gemini')) return parseGeminiTranscript(events);
  if (b.includes('codex')) return parseCodexTranscript(events);
  return parseClaudeTranscript(events);
}

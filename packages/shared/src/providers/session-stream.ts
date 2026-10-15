/**
 * The existing runChat stream composition. Every session gets its own guards,
 * dialogue and send receipts; hosts render the output without reinterpreting it.
 * This is not a durable replay/live bridge or a delivery acknowledgement.
 */
import {
  compactForLedger,
  findImitatedToolResults,
  isPotentialImitationPrefix,
  ImitationPreviewGuard,
  spawnDialogueText,
  StreamedTurnRenderer,
  stripLocalToolBlocks,
  type ReseedDialogueEntry,
  type StreamedLine,
} from '../runtime/index.js';
import { backendSendTarget, type TurnSend } from '../runner/turn-reply.js';
import type { BackendMessageSource, BackendTextSource, BackendTurnEvent } from './stream.js';

interface DisplayBlock {
  text: string;
  complete: boolean;
  conflict: boolean;
}

function messageKey(source: BackendMessageSource): string {
  return JSON.stringify([source.origin, source.parentToolUseId, source.messageId]);
}

export interface SessionStreamPorts {
  /** Live: a host may switch routing between turns. */
  toolRouting(): 'local' | 'backend';
  append(entry: Record<string, unknown>): number;
  render(lines: StreamedLine[]): void;
  toolStarted(name: string): void;
  /** Legacy liveness/tool tracking, not an observer or send_response channel. */
  progress(event: Record<string, unknown>): void;
  modelReported(model: string): void;
}

export class SessionStream {
  readonly renderer: StreamedTurnRenderer;
  /** Continuations append their real tool results to this same array. */
  dialogue: ReseedDialogueEntry[] = [];
  sends: TurnSend[] = [];
  /** Only this run's stream evidence; never a requested or hydrated model. */
  currentModel: string | undefined;
  private readonly previewGuard: ImitationPreviewGuard;
  private readonly pendingBackendSends = new Map<string, TurnSend>();
  private dialogueMuted = false;
  private spawnSaid = '';
  private spawnEntryIndex = -1;
  /** Display correlation only, cleared for every actual provider attempt. */
  private readonly messages = new Map<string, Map<string, DisplayBlock>>();
  private readonly renderedMessages = new Set<string>();
  private readonly interleavedMessages = new Set<string>();
  private lastRenderedMessage: string | undefined;

  constructor(private readonly ports: SessionStreamPorts) {
    this.renderer = new StreamedTurnRenderer(
      (text) => (ports.toolRouting() === 'local' ? stripLocalToolBlocks(text) : text),
      {
        guard: (text) => (ports.toolRouting() === 'local' ? findImitatedToolResults(text) : null),
      }
    );
    this.previewGuard = new ImitationPreviewGuard(
      (text) => (ports.toolRouting() === 'local' ? findImitatedToolResults(text) : null),
      (line) => ports.toolRouting() === 'local' && isPotentialImitationPrefix(line)
    );
  }

  resetTurn(): void {
    this.renderer.reset();
    this.dialogue = [];
    this.dialogueMuted = false;
    this.messages.clear();
    this.renderedMessages.clear();
    this.interleavedMessages.clear();
    this.lastRenderedMessage = undefined;
  }

  resetSends(): void {
    this.sends = [];
    this.pendingBackendSends.clear();
  }

  beginSpawn(): void {
    this.renderer.beginSpawn();
    this.previewGuard.beginSpawn();
    this.dialogueMuted = false;
    this.spawnSaid = '';
    this.spawnEntryIndex = -1;
    this.messages.clear();
    this.renderedMessages.clear();
    this.interleavedMessages.clear();
    this.lastRenderedMessage = undefined;
  }

  endSpawn(): void {
    this.ports.render(this.renderer.endSpawn());
    const held = this.previewGuard.endSpawn();
    if (held.trim()) {
      this.ports.append({ type: 'backend_text', preview: compactForLedger(held, 200) });
    }
  }

  handle(evt: BackendTurnEvent): void {
    const { ports } = this;
    if (evt.kind === 'text-boundary') {
      if (
        evt.boundary === 'block-start' &&
        evt.source.blockId !== undefined &&
        evt.text !== undefined
      ) {
        this.positionedText(
          { ...evt.source, blockId: evt.source.blockId, offset: 0 },
          evt.text ?? '',
          false
        );
      }
      return;
    }
    if ((evt.kind === 'text' || evt.kind === 'text-delta') && evt.source) {
      this.positionedText(evt.source, evt.text, evt.kind === 'text');
      return;
    }
    if (evt.kind === 'result' && evt.source && !evt.error && typeof evt.text === 'string') {
      const blocks = this.messages.get(messageKey(evt.source));
      if (blocks && [...blocks.values()].every((block) => block.complete && !block.conflict)) {
        const text = [...blocks.values()].map((block) => block.text).join('');
        if (text === evt.text) this.confirmMessage(messageKey(evt.source), text);
      }
      return;
    }
    if (evt.kind === 'tool-use') {
      const target = backendSendTarget(evt.name, evt.input);
      if (target && evt.id) this.pendingBackendSends.set(evt.id, target);
      ports.toolStarted(evt.name);
      ports.append({
        type: 'backend_tool',
        name: evt.name,
        status: 'running',
        ...(evt.id ? { toolUseId: evt.id } : {}),
      });
      ports.progress({
        type: 'tool_call',
        toolName: evt.name,
        status: 'running',
        layer: 'backend',
        ...(evt.id ? { toolUseId: evt.id } : {}),
      });
    } else if (evt.kind === 'tool-result') {
      const target = evt.id ? this.pendingBackendSends.get(evt.id) : undefined;
      if (target) {
        this.pendingBackendSends.delete(evt.id!);
        if (!evt.isError) this.sends.push(target);
      }
      ports.append({
        type: 'backend_tool',
        status: evt.isError ? 'error' : 'done',
        ...(evt.id ? { toolUseId: evt.id } : {}),
      });
    } else if (evt.kind === 'text-delta') {
      this.noteUnpositionedText(evt.text);
      ports.render(this.renderer.pushDelta(evt.text));
    } else if (evt.kind === 'text' && evt.text.trim()) {
      this.noteUnpositionedText(evt.text);
      this.recordText(evt.text);
      ports.render(
        this.renderer.completeMessage(evt.text, { continuesMessage: evt.continuesMessage })
      );
    } else if (evt.kind === 'model') {
      // Even a confirmation of the pinned model is fresh run evidence.
      this.currentModel = evt.model;
      ports.modelReported(evt.model);
    }
  }

  private noteUnpositionedText(text: string): void {
    if (!text) return;
    if (this.lastRenderedMessage !== undefined) {
      // The append-only renderer cannot attribute this output to the preceding
      // positioned message. Persist the ambiguity so a later exact snapshot or
      // result cannot restore a false claim that its intact final was shown.
      this.interleavedMessages.add(this.lastRenderedMessage);
      this.renderer.clearMessageConfirmation();
    }
    this.lastRenderedMessage = undefined;
  }

  private positionedText(source: BackendTextSource, text: string, complete: boolean): void {
    const key = messageKey(source);
    let message = this.messages.get(key);
    if (!message) this.messages.set(key, (message = new Map()));
    let block = message.get(source.blockId);
    if (!block) {
      block = { text: '', complete: false, conflict: false };
      message.set(source.blockId, block);
    }
    if (block.conflict) return;
    const offset = source.offset;
    const overlap = Math.min(text.length, block.text.length - offset);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > block.text.length ||
      block.text.slice(offset, offset + overlap) !== text.slice(0, overlap) ||
      (complete && (offset !== 0 || text.length < block.text.length)) ||
      (block.complete && offset + text.length > block.text.length)
    ) {
      // Do not publish a rewrite/gap as new dialogue. This is NOT effect
      // validation: the original event remains untouched for that consumer.
      block.conflict = true;
      return;
    }
    const fresh = text.slice(overlap);
    block.text += fresh;
    if (fresh) {
      if (this.lastRenderedMessage !== key && this.renderedMessages.has(key))
        this.interleavedMessages.add(key);
      this.renderedMessages.add(key);
      this.lastRenderedMessage = key;
      this.ports.render(this.renderer.pushDelta(fresh));
    }
    if (complete && !block.complete) {
      block.complete = true;
      this.recordText(block.text);
      const completed = [...message.values()].filter((part) => part.complete);
      this.confirmMessage(key, completed.map((part) => part.text).join(''));
    }
  }

  private confirmMessage(key: string, text: string): void {
    // The paragraph renderer is append-only. It cannot retract a foreign chunk
    // that arrived between two fragments of this message. Do not claim that
    // its intact final text is already on screen in that case.
    if (this.interleavedMessages.has(key)) this.renderer.clearMessageConfirmation();
    else this.renderer.confirmMessage(text);
  }

  private recordText(text: string): void {
    // Judge the whole spawn, not each block: a later block can reveal that
    // the prior block's trailing line was the beginning of a forged frame.
    const guarded = this.previewGuard.onBlock(text);
    if (guarded.publish.trim() || guarded.imitationDiscarded) {
      this.ports.append({
        type: 'backend_text',
        preview: compactForLedger(guarded.publish, 200),
        ...(guarded.imitationDiscarded ? { imitationDiscarded: true } : {}),
      });
    }
    if (!this.dialogueMuted) {
      this.spawnSaid += text;
      const said = spawnDialogueText(this.spawnSaid, guarded);
      if (this.spawnEntryIndex === -1) {
        if (said.trim()) {
          this.dialogue.push({ role: 'assistant', text: said });
          this.spawnEntryIndex = this.dialogue.length - 1;
        }
      } else {
        this.dialogue[this.spawnEntryIndex] = { role: 'assistant', text: said };
      }
      if (guarded.imitationDiscarded) this.dialogueMuted = true;
    }
  }
}

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
import type { BackendTurnEvent } from './stream.js';

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
      ports.render(this.renderer.pushDelta(evt.text));
    } else if (evt.kind === 'text' && evt.text.trim()) {
      // Judge the whole spawn, not each block: a later block can reveal that
      // the prior block's trailing line was the beginning of a forged frame.
      const guarded = this.previewGuard.onBlock(evt.text);
      if (guarded.publish.trim() || guarded.imitationDiscarded) {
        ports.append({
          type: 'backend_text',
          preview: compactForLedger(guarded.publish, 200),
          ...(guarded.imitationDiscarded ? { imitationDiscarded: true } : {}),
        });
      }
      if (!this.dialogueMuted) {
        this.spawnSaid += evt.text;
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
      ports.render(
        this.renderer.completeMessage(evt.text, { continuesMessage: evt.continuesMessage })
      );
    } else if (evt.kind === 'model') {
      // Even a confirmation of the pinned model is fresh run evidence.
      this.currentModel = evt.model;
      ports.modelReported(evt.model);
    }
  }
}

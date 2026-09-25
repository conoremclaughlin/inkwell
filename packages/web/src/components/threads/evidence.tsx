'use client';

import { useState } from 'react';
import { ShieldCheck, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { formatClockTime, formatDayLabel } from '@inklabs/shared/stories/thread-viewing';

// ─── Types mirroring GET /api/admin/threads/graph-evidence ───

type EvidenceField =
  | { label: string; kind: 'text'; text: string }
  | { label: string; kind: 'sha'; sha: string }
  | { label: string; kind: 'link'; href: string; text: string }
  | { label: string; kind: 'chips'; items: string[] }
  | { label: string; kind: 'media'; path: string; mediaType: 'image' | 'video' | 'pdf' }
  | { label: string; kind: 'group'; fields: EvidenceField[] }
  | { label: string; kind: 'json'; json: string };

interface ReasonPart {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

interface EvidenceGateEvent {
  event: string;
  attempt: number;
  actorAgentSlug: string | null;
  actorIsUser: boolean;
  reasonParts: ReasonPart[];
  evidenceFields: EvidenceField[];
  createdAt: string;
}

interface EvidenceAttempt {
  attempt: number;
  verdict: 'passed' | 'failed' | null;
  events: EvidenceGateEvent[];
}

interface EvidenceNode {
  id: string;
  title: string;
  nodeSlug: string | null;
  taskType: string;
  status: string | null;
  outcome: string | null;
  gateState: string | null;
  gateAttempt: number | null;
  assigneeAgentSlug: string | null;
  assigneeIsUser: boolean;
  attempts: EvidenceAttempt[];
}

export interface EvidenceGroup {
  id: string;
  title: string;
  status: string | null;
  executionModel: string | null;
  executionPhase: string | null;
  nodes: EvidenceNode[];
}

export interface GraphEvidenceResponse {
  groups: EvidenceGroup[];
  meta?: {
    groups: { fetched: number; total: number; truncated?: boolean };
    events?: { fetched: number; total: number; truncated: boolean };
  };
}

// ─── Evidence rendering ───

const NODE_STATE_COLORS: Record<string, string> = {
  passed: 'bg-emerald-500/15 text-emerald-600',
  completed: 'bg-emerald-500/15 text-emerald-600',
  failed: 'bg-red-500/15 text-red-500',
  blocked: 'bg-red-500/15 text-red-500',
  open: 'bg-amber-500/15 text-amber-600',
  in_progress: 'bg-blue-500/15 text-blue-500',
  not_ready: 'bg-muted text-muted-foreground',
  pending: 'bg-muted text-muted-foreground',
};

/** The single state chip a node shows: gate state for gates, status for work. */
function nodeState(node: EvidenceNode): string {
  if (node.taskType === 'verification') return node.gateState ?? 'not_ready';
  return node.status ?? 'pending';
}

const EVENT_LABELS: Record<string, string> = {
  opened: 'gate opened',
  scheduled: 'scheduled',
  claimed: 'claimed',
  claim_released: 'released',
  claim_reclaimed: 'claim reclaimed',
  retry_requested: 'retry requested',
  reassigned: 'reassigned',
  passed: 'passed',
  failed: 'failed',
};

export function EvidenceNodeCard({ node }: { node: EvidenceNode }) {
  const isGate = node.taskType === 'verification';
  const NodeIcon = isGate ? ShieldCheck : Wrench;
  const state = nodeState(node);
  const totalAttempts = node.attempts.length;

  return (
    <div className="rounded-md border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <NodeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{node.title}</span>
        <span
          className={clsx(
            'rounded px-1.5 py-0.5 text-[10px] font-medium',
            NODE_STATE_COLORS[state] ?? 'bg-muted text-muted-foreground'
          )}
        >
          {state.replace('_', ' ')}
        </span>
        {isGate && totalAttempts > 1 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {totalAttempts} attempts
          </span>
        )}
        {node.assigneeAgentSlug && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            assignee {node.assigneeAgentSlug}
          </span>
        )}
        {node.assigneeIsUser && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">assignee: you</span>
        )}
      </div>

      {node.attempts.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {node.attempts.map((attempt) => (
            <div key={attempt.attempt} className="flex flex-col gap-1">
              {(totalAttempts > 1 || attempt.verdict) && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {totalAttempts > 1 && (
                    <span className="font-medium uppercase tracking-wide">
                      Attempt {attempt.attempt}
                    </span>
                  )}
                  {attempt.verdict && (
                    <span
                      className={clsx(
                        'rounded px-1 py-0.5 font-medium',
                        NODE_STATE_COLORS[attempt.verdict]
                      )}
                    >
                      {attempt.verdict}
                    </span>
                  )}
                </div>
              )}
              {attempt.events.map((gateEvent, eventIndex) => (
                <GateEventRow key={`${gateEvent.createdAt}-${eventIndex}`} gateEvent={gateEvent} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GateEventRow({ gateEvent }: { gateEvent: EvidenceGateEvent }) {
  const isVerdict = gateEvent.event === 'passed' || gateEvent.event === 'failed';
  const isRemediation = gateEvent.event === 'retry_requested';
  const actor = gateEvent.actorIsUser ? 'you' : gateEvent.actorAgentSlug;
  const clock = (
    <span
      className="ml-auto shrink-0 text-[10px] text-muted-foreground"
      title={new Date(gateEvent.createdAt).toLocaleString()}
    >
      {formatDayLabel(gateEvent.createdAt)} {formatClockTime(gateEvent.createdAt)}
    </span>
  );

  // Lifecycle events stay one quiet line; verdicts and remediations carry
  // the story and get room for their reasons and evidence.
  if (!isVerdict && !isRemediation) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{EVENT_LABELS[gateEvent.event] ?? gateEvent.event}</span>
        {actor && <span>· {actor}</span>}
        {gateEvent.reasonParts.length > 0 && (
          <span className="truncate">
            · <ReasonText parts={gateEvent.reasonParts} />
          </span>
        )}
        {clock}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'rounded-md border px-2.5 py-2',
        gateEvent.event === 'failed' && 'border-red-500/30 bg-red-500/5',
        gateEvent.event === 'passed' && 'border-emerald-500/30 bg-emerald-500/5',
        isRemediation && 'border-dashed'
      )}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span
          className={clsx(
            'font-medium',
            gateEvent.event === 'failed' && 'text-red-500',
            gateEvent.event === 'passed' && 'text-emerald-600'
          )}
        >
          {EVENT_LABELS[gateEvent.event] ?? gateEvent.event}
        </span>
        {actor && <span className="text-muted-foreground">by {actor}</span>}
        {clock}
      </div>
      {gateEvent.reasonParts.length > 0 && (
        <div className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed">
          <ReasonText parts={gateEvent.reasonParts} />
        </div>
      )}
      {gateEvent.evidenceFields.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {gateEvent.evidenceFields.map((field, fieldIndex) => (
            <EvidenceFieldView key={`${field.label}-${fieldIndex}`} field={field} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReasonText({ parts }: { parts: ReasonPart[] }) {
  return (
    <>
      {parts.map((part, partIndex) =>
        part.kind === 'link' && part.href ? (
          <a
            key={partIndex}
            href={part.href}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline-offset-2 hover:underline"
          >
            {part.text}
          </a>
        ) : (
          <span key={partIndex}>{part.text}</span>
        )
      )}
    </>
  );
}

function mediaUrl(evidencePath: string): string {
  return `/api/admin/media?path=${encodeURIComponent(evidencePath)}`;
}

function EvidenceFieldView({ field, nested }: { field: EvidenceField; nested?: boolean }) {
  const label = (
    <span className="w-28 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
      {field.label}
    </span>
  );

  switch (field.kind) {
    case 'sha':
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]" title={field.sha}>
            {field.sha.slice(0, 12)}
          </span>
        </div>
      );
    case 'link':
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          <a
            href={field.href}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[11px] text-primary underline-offset-2 hover:underline"
            title={field.href}
          >
            {field.text}
          </a>
        </div>
      );
    case 'chips':
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          <span className="flex flex-wrap gap-1">
            {field.items.map((item, itemIndex) => (
              <span key={itemIndex} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                {item}
              </span>
            ))}
          </span>
        </div>
      );
    case 'media':
      return (
        <div className={clsx('flex flex-col gap-1', nested && 'pl-3')}>
          {label}
          <MediaPreview path={field.path} mediaType={field.mediaType} />
        </div>
      );
    case 'group':
      return (
        <div className={clsx('flex flex-col gap-1', nested && 'pl-3')}>
          {label}
          {field.fields.map((innerField, innerIndex) => (
            <EvidenceFieldView
              key={`${innerField.label}-${innerIndex}`}
              field={innerField}
              nested
            />
          ))}
        </div>
      );
    case 'json':
      return (
        <div className={clsx('flex flex-col gap-1', nested && 'pl-3')}>
          {label}
          <pre className="overflow-x-auto rounded bg-muted p-2 text-[10px]">{field.json}</pre>
        </div>
      );
    default:
      return (
        <div className={clsx('flex items-baseline gap-2', nested && 'pl-3')}>
          {label}
          {/* min-w-0 lets the value shrink inside the flex row; break-all
              handles unbroken tokens like github:owner/repo#547@sha. */}
          <span className="min-w-0 break-all text-[11px]">{field.text}</span>
        </div>
      );
  }
}

/**
 * Inline preview for a file referenced by evidence, served through the
 * allowlisted media endpoint. A missing/expired file degrades to the bare
 * path (the reference is still information) instead of a broken tile.
 */
function MediaPreview({ path, mediaType }: { path: string; mediaType: 'image' | 'video' | 'pdf' }) {
  const [failed, setFailed] = useState(false);
  const url = mediaUrl(path);

  if (failed || mediaType === 'pdf') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={clsx(
          'break-all font-mono text-[10px] underline-offset-2 hover:underline',
          failed ? 'text-muted-foreground' : 'text-primary'
        )}
        title={failed ? 'File not available — showing the recorded path' : 'Open'}
      >
        {path}
      </a>
    );
  }

  if (mediaType === 'video') {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-64 max-w-full rounded-md border"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer" title={path}>
      {/* eslint-disable-next-line @next/next/no-img-element -- authed same-origin endpoint; next/image cannot optimize it */}
      <img
        src={url}
        alt={path}
        loading="lazy"
        className="max-h-64 max-w-full rounded-md border object-contain"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

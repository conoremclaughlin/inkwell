/**
 * Graph evidence shaping — pure logic for the /threads evidence viewer.
 *
 * The gate-event ledger (task_gate_events) is the executor's transactional
 * source of truth; this module turns its rows into a display model the
 * dashboard can render without knowing evidence shapes in advance. Evidence
 * JSONB is free-form by design (requirements are a checklist, not a
 * bouncer — Conor, 2026-08-31), so rendering is heuristic: the classifier
 * recognizes what it can (SHAs, URLs, media paths, check lists) and
 * degrades to labeled text/JSON for everything else. Legacy evidence from
 * the pr:543/pr:547 graph runs renders without any migration.
 */

const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/;
/** Matches URLs embedded in prose (gate failure reasons often carry one). */
const EMBEDDED_URL_PATTERN = /https?:\/\/[^\s)"'<>\]]+/g;

const MEDIA_EXTENSIONS: Record<string, 'image' | 'video' | 'pdf'> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  pdf: 'pdf',
};

export type MediaType = 'image' | 'video' | 'pdf';

/**
 * A single renderable piece of an evidence object. `group` nests one level
 * (e.g. pr:543's verification sub-object); anything deeper degrades to
 * `json` so the renderer never recurses unboundedly.
 */
export type EvidenceField =
  | { label: string; kind: 'text'; text: string }
  | { label: string; kind: 'sha'; sha: string }
  | { label: string; kind: 'link'; href: string; text: string }
  | { label: string; kind: 'chips'; items: string[] }
  | { label: string; kind: 'media'; path: string; mediaType: MediaType }
  | { label: string; kind: 'group'; fields: EvidenceField[] }
  | { label: string; kind: 'json'; json: string };

export interface ReasonPart {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

/** Media type for a plausible file path, or null when it is not one. */
export function mediaTypeForPath(candidatePath: string): MediaType | null {
  // Paths carry a separator or home prefix; bare labels like "1440x2600"
  // (real data from the pr:547 verdict) must never become media requests.
  const looksLikePath = candidatePath.includes('/') || candidatePath.startsWith('~');
  if (!looksLikePath) return null;
  const extensionMatch = /\.([a-z0-9]+)$/i.exec(candidatePath);
  if (!extensionMatch) return null;
  return MEDIA_EXTENSIONS[extensionMatch[1].toLowerCase()] ?? null;
}

/** Split prose into text/link parts so reasons render with live links. */
export function linkifyText(text: string): ReasonPart[] {
  const parts: ReasonPart[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(EMBEDDED_URL_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      parts.push({ kind: 'text', text: text.slice(lastIndex, matchIndex) });
    }
    parts.push({ kind: 'link', text: match[0], href: match[0] });
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return parts;
}

function labelize(rawKey: string): string {
  // camelCase / snake_case → spaced words for display labels.
  return rawKey
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classifyString(label: string, value: string): EvidenceField {
  if (FULL_GIT_SHA_PATTERN.test(value)) {
    return { label, kind: 'sha', sha: value };
  }
  if (HTTP_URL_PATTERN.test(value)) {
    return { label, kind: 'link', href: value, text: value };
  }
  const mediaType = mediaTypeForPath(value);
  if (mediaType) {
    return { label, kind: 'media', path: value, mediaType };
  }
  return { label, kind: 'text', text: value };
}

function classifyArray(label: string, values: unknown[]): EvidenceField[] {
  if (values.length === 0) {
    return [{ label, kind: 'chips', items: [] }];
  }

  // An array of media paths (e.g. committed screenshot files) becomes one
  // media field per file so each renders inline.
  if (values.every((item) => typeof item === 'string' && mediaTypeForPath(item) !== null)) {
    return (values as string[]).map((path, index) => ({
      label: values.length > 1 ? `${label} ${index + 1}` : label,
      kind: 'media',
      path,
      mediaType: mediaTypeForPath(path) as MediaType,
    }));
  }

  if (values.every((item) => typeof item !== 'object' || item === null)) {
    return [{ label, kind: 'chips', items: values.map((item) => String(item)) }];
  }

  // Array of flat objects (e.g. checks: [{name, status}]) → one chip per
  // object joining its primitive values.
  if (
    values.every(
      (item) =>
        isPlainObject(item) &&
        Object.values(item).every((inner) => typeof inner !== 'object' || inner === null) &&
        Object.keys(item).length <= 4
    )
  ) {
    return [
      {
        label,
        kind: 'chips',
        items: (values as Record<string, unknown>[]).map((item) =>
          Object.values(item)
            .map((inner) => String(inner))
            .join(' · ')
        ),
      },
    ];
  }

  return [{ label, kind: 'json', json: JSON.stringify(values, null, 2) }];
}

function classifyValue(label: string, value: unknown, depth: number): EvidenceField[] {
  if (typeof value === 'string') return [classifyString(label, value)];
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [{ label, kind: 'text', text: String(value) }];
  }
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return classifyArray(label, value);
  if (isPlainObject(value)) {
    if (depth >= 1) {
      return [{ label, kind: 'json', json: JSON.stringify(value, null, 2) }];
    }
    const innerFields = Object.entries(value).flatMap(([innerKey, innerValue]) =>
      classifyValue(labelize(innerKey), innerValue, depth + 1)
    );
    return [{ label, kind: 'group', fields: innerFields }];
  }
  return [{ label, kind: 'json', json: JSON.stringify(value) }];
}

/**
 * Turn an evidence JSONB value into ordered display fields. Non-object
 * evidence (a bare string, an array) still renders — the ledger accepts
 * free-form evidence and the viewer must never white-screen on shape.
 */
export function classifyEvidence(evidence: unknown): EvidenceField[] {
  if (evidence === null || evidence === undefined) return [];
  if (isPlainObject(evidence)) {
    return Object.entries(evidence).flatMap(([key, value]) =>
      classifyValue(labelize(key), value, 0)
    );
  }
  return classifyValue('evidence', evidence, 0);
}

// ── Event grouping ───────────────────────────────────────────────────────

export interface GateEventInput {
  event: string;
  attempt: number;
  gateVersion: number;
  sessionId: string | null;
  actorAgentSlug: string | null;
  actorIsUser: boolean;
  evidence: unknown;
  reason: string | null;
  createdAt: string;
}

export interface DisplayGateEvent {
  event: string;
  attempt: number;
  actorAgentSlug: string | null;
  actorIsUser: boolean;
  reasonParts: ReasonPart[];
  evidenceFields: EvidenceField[];
  createdAt: string;
}

export interface AttemptGroup {
  attempt: number;
  /** Terminal verdict of this attempt, when one was recorded. */
  verdict: 'passed' | 'failed' | null;
  events: DisplayGateEvent[];
}

/**
 * Group one node's ledger events by attempt, oldest attempt first, events
 * in time order inside each. A retry_requested row is stamped with the NEW
 * attempt number by the RPC, so it naturally opens the next group —
 * exactly how the story reads: remediation begins the fresh attempt.
 */
export function groupNodeEvents(events: GateEventInput[]): AttemptGroup[] {
  const groupsByAttempt = new Map<number, AttemptGroup>();
  const chronological = [...events].sort((first, second) => {
    const byTime = Date.parse(first.createdAt) - Date.parse(second.createdAt);
    return byTime !== 0 ? byTime : first.attempt - second.attempt;
  });

  for (const event of chronological) {
    let group = groupsByAttempt.get(event.attempt);
    if (!group) {
      group = { attempt: event.attempt, verdict: null, events: [] };
      groupsByAttempt.set(event.attempt, group);
    }
    if (event.event === 'passed' || event.event === 'failed') {
      group.verdict = event.event;
    }
    group.events.push({
      event: event.event,
      attempt: event.attempt,
      actorAgentSlug: event.actorAgentSlug,
      actorIsUser: event.actorIsUser,
      reasonParts: event.reason ? linkifyText(event.reason) : [],
      evidenceFields: classifyEvidence(event.evidence),
      createdAt: event.createdAt,
    });
  }

  return [...groupsByAttempt.values()].sort((first, second) => first.attempt - second.attempt);
}

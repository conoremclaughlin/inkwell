/**
 * Graph template constructors (spec: ink://specs/workflow-graph v10 §Templates)
 *
 * A template encodes OBLIGATIONS, not instructions. The creative work stays
 * one open-ended node — any template that tries to decompose the work is
 * wrong for most tasks and stale immediately. What the graph pins down is the
 * promises around that work: who independently signs off, and on what.
 *
 * Requirements are a CHECKLIST, NOT A BOUNCER (Conor, 2026-08-31). Nothing in
 * this module is validated server-side and nothing here can refuse a verdict.
 * The enforcement the graph already provides is structural: a gate does not
 * pass until its assignee — who is not the author — records a verdict, and
 * the group visibly blocks until they do. Requirements exist so that at the
 * moment the gate opens, the assignee is reminded what this gate is for.
 * That reminder is the whole point; see renderRequirementChecklist.
 */

/** Gate lifecycle (spec §Node types and gate modes). */
export type GateMode = 'executable' | 'approval';

export type NodePriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * A rendering vocabulary, never a schema. `kind` tells the evidence viewer
 * how to display what was recorded; it does not constrain what may be
 * recorded, and a verdict citing none of these is still a valid verdict.
 */
export type RequirementKind = 'sha' | 'check' | 'merge-tree' | 'media' | 'link' | 'note';

export interface GateRequirement {
  /** What the assignee should look for, in their own reading order. */
  label: string;
  /** How to satisfy it — a command to run, a place to look. Optional. */
  detail?: string;
  kind?: RequirementKind;
}

export interface GraphTemplateNode {
  /** Stable within the group; how a constructor names its own parts. */
  slug: string;
  type: 'work' | 'verification';
  title: string;
  description?: string;
  priority?: NodePriority;
  /** Gates carry exactly one principal — an SB identity or a human user. */
  assigneeIdentityId?: string;
  assigneeUserId?: string;
  verification?: {
    mode: GateMode;
    requirements: GateRequirement[];
    /** Dwell before the gate becomes actionable (spec v7). */
    notBeforeSeconds?: number;
  };
}

export interface GraphTemplateEdge {
  /** A node slug in this shape, or a raw task UUID for an injection. */
  from: string;
  to: string;
}

export interface GraphShape {
  nodes: GraphTemplateNode[];
  edges: GraphTemplateEdge[];
}

/** Params every constructor accepts; individual templates extend this. */
export interface TemplateParams {
  /** Human-readable subject — a PR number, a spec slug. */
  subject?: string;
  /** SB identity UUID that reviews (agent_identities.id). */
  reviewerIdentityId?: string;
  /** Who signs off visually — a human user UUID. */
  visualSignoffUserId?: string;
  /** SB identity UUID that signs off visually, when no human is in the loop. */
  visualSignoffIdentityId?: string;
  /** Extra checklist items appended to the review gate. */
  extraReviewRequirements?: GateRequirement[];
  /**
   * Anchor slugs/UUIDs for a fragment injected into an existing graph:
   * the fragment is spliced between them.
   */
  after?: string;
  before?: string;
  [key: string]: unknown;
}

export interface GraphTemplate<P extends TemplateParams = TemplateParams> {
  id: string;
  /** Bumped whenever the emitted shape changes; recorded on the revision. */
  version: string;
  summary: string;
  /** True for shapes meant to be spliced into a graph that already exists. */
  injectable?: boolean;
  build(params: P): GraphShape;
}

/**
 * The checklist as the assignee reads it at dispatch. Plain text on purpose:
 * it goes into an inbox message, not a UI.
 */
export function renderRequirementChecklist(requirements: GateRequirement[]): string {
  if (requirements.length === 0) return '';
  const lines = requirements.map((requirement) => {
    const detail = requirement.detail ? ` — ${requirement.detail}` : '';
    return `  [ ] ${requirement.label}${detail}`;
  });
  return `This gate is asking for:\n${lines.join('\n')}`;
}

/**
 * The block appended to the message that OPENS a gate — the moment the
 * reminder has to arrive. A checklist stored on a node is a checklist nobody
 * reads: the assignee is woken by that message and acts on what it says, so
 * whatever the gate wants has to be in it.
 *
 * Takes the raw `verification` JSONB because a gate may have been authored by
 * hand, by an older constructor, or by a template that has since changed
 * shape — anything unrecognisable is skipped rather than allowed to break a
 * dispatch. Returns '' when there is nothing to say.
 */
export function renderGateChecklistBlock(verification: unknown): string {
  const requirements = (verification as { requirements?: unknown } | null | undefined)
    ?.requirements;
  if (!Array.isArray(requirements)) return '';
  const usable = requirements.filter(
    (requirement): requirement is GateRequirement =>
      Boolean(requirement) &&
      typeof (requirement as { label?: unknown }).label === 'string' &&
      (requirement as { label: string }).label.trim() !== ''
  );
  const checklist = renderRequirementChecklist(usable);
  if (!checklist) return '';
  return (
    `\n\n${checklist}\n` +
    'These are what the gate is FOR, not a schema — record them in your evidence in ' +
    'whatever shape fits, and say so plainly if one does not apply.'
  );
}

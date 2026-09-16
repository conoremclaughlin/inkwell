/**
 * The template registry — versioned constructors (spec v10 §Templates).
 *
 * Every template emits the same thing: a flat set of typed nodes and the
 * edges between them. There is no runtime machinery here and no new concept
 * in the schema; a template is a function that knows a good shape.
 *
 * Two kinds live side by side:
 *
 *   - whole shapes (`pr-ship`, `spec-ship`) that build a graph from nothing;
 *   - injectable fragments (`visual-signoff`, `sibling-review`) that splice a
 *     single obligation into a graph already running, for when scope grows
 *     mid-flight and a PR that started as pure logic sprouts an interface.
 *
 * The second kind is why node authoring is additive: injection and
 * instantiation are the same call with different inputs.
 */

import { createHash } from 'crypto';
import {
  composeShapes,
  mergeFragment,
  siblingReviewFragment,
  visualSignoffFragment,
  workFragment,
} from './fragments';
import type { GraphShape, GraphTemplate, TemplateParams } from './types';

export interface PrShipParams extends TemplateParams {
  subject?: string;
  reviewerIdentityId?: string;
  visualSignoffUserId?: string;
  visualSignoffIdentityId?: string;
  workTitle?: string;
  workDescription?: string;
  /** Drop the visual gate when the change provably has no user-visible surface. */
  includeVisualSignoff?: boolean;
}

/**
 * work → sibling-review ┐
 *      → visual-signoff ┴→ merge
 *
 * Four nodes for any PR regardless of size. The two gates are independent of
 * each other and both block the merge, so a stalled visual sign-off never
 * blocks the code review from being recorded, and neither one alone lets the
 * merge through.
 */
export const prShipTemplate: GraphTemplate<PrShipParams> = {
  id: 'pr-ship',
  version: '1',
  summary: 'Work, an independent sibling review, a visual sign-off, then merge.',
  build(params: PrShipParams): GraphShape {
    const subject = params.subject ?? 'this PR';
    const includeVisual = params.includeVisualSignoff ?? true;

    const shape = composeShapes(
      workFragment({
        title: params.workTitle ?? `Implement ${subject}`,
        description:
          params.workDescription ??
          `Open-ended: do the work for ${subject} however it needs doing, then open the PR. ` +
            'This node is not a plan — the gates below are what this graph is actually holding you to.',
      }),
      siblingReviewFragment({
        subject,
        ...(params.reviewerIdentityId ? { assigneeIdentityId: params.reviewerIdentityId } : {}),
        ...(params.extraReviewRequirements
          ? { extraRequirements: params.extraReviewRequirements }
          : {}),
      }),
      ...(includeVisual
        ? [
            visualSignoffFragment({
              subject,
              ...(params.visualSignoffUserId
                ? { assigneeUserId: params.visualSignoffUserId }
                : { assigneeIdentityId: params.visualSignoffIdentityId }),
            }),
          ]
        : []),
      mergeFragment({ subject })
    );

    shape.edges = [
      { from: 'work', to: 'sibling-review' },
      { from: 'sibling-review', to: 'merge' },
      ...(includeVisual
        ? [
            { from: 'work', to: 'visual-signoff' },
            { from: 'visual-signoff', to: 'merge' },
          ]
        : []),
    ];
    return shape;
  },
};

export interface SpecShipParams extends TemplateParams {
  subject?: string;
  reviewerIdentityId?: string;
  workTitle?: string;
}

/**
 * work → sibling-review → publish. The same review obligation as pr-ship,
 * with the merge replaced by an artifact publish and no visual gate — a spec
 * has no rendered surface to photograph.
 */
export const specShipTemplate: GraphTemplate<SpecShipParams> = {
  id: 'spec-ship',
  version: '1',
  summary: 'Draft a spec, get an independent review, then publish the artifact.',
  build(params: SpecShipParams): GraphShape {
    const subject = params.subject ?? 'this spec';
    const shape = composeShapes(
      workFragment({
        title: params.workTitle ?? `Draft ${subject}`,
        description: `Write ${subject}. Open-ended — the review gate below is the obligation.`,
      }),
      siblingReviewFragment({
        subject,
        ...(params.reviewerIdentityId ? { assigneeIdentityId: params.reviewerIdentityId } : {}),
        ...(params.extraReviewRequirements
          ? { extraRequirements: params.extraReviewRequirements }
          : {}),
      }),
      {
        nodes: [
          {
            slug: 'publish',
            type: 'work' as const,
            title: `Publish ${subject}`,
            description:
              `Stamp the reviewed version via update_artifact once the review gate passes. ` +
              'Read a content property back afterwards — a version bump is not proof the payload landed.',
            priority: 'high' as const,
          },
        ],
        edges: [],
      }
    );
    shape.edges = [
      { from: 'work', to: 'sibling-review' },
      { from: 'sibling-review', to: 'publish' },
    ];
    return shape;
  },
};

/**
 * Splice one gate between two existing nodes. `after` and `before` are node
 * slugs or raw task UUIDs already in the graph; `before` may be omitted when
 * the gate is terminal.
 */
function injectableGate(
  id: string,
  version: string,
  summary: string,
  buildGate: (params: TemplateParams, subject: string) => GraphShape
): GraphTemplate {
  return {
    id,
    version,
    summary,
    injectable: true,
    build(params: TemplateParams): GraphShape {
      const subject = params.subject ?? 'this change';
      const shape = buildGate(params, subject);
      const slug = shape.nodes[0].slug;
      shape.edges = [
        ...(params.after ? [{ from: params.after, to: slug }] : []),
        ...(params.before ? [{ from: slug, to: params.before }] : []),
      ];
      return shape;
    },
  };
}

export const visualSignoffTemplate = injectableGate(
  'visual-signoff',
  '1',
  'Inject a visual sign-off gate into a graph whose scope grew a user-visible surface.',
  (params, subject) =>
    visualSignoffFragment({
      subject,
      ...(params.visualSignoffUserId
        ? { assigneeUserId: params.visualSignoffUserId }
        : { assigneeIdentityId: params.visualSignoffIdentityId }),
    })
);

export const siblingReviewTemplate = injectableGate(
  'sibling-review',
  '1',
  'Inject an independent sibling-review gate into an existing graph.',
  (params, subject) =>
    siblingReviewFragment({
      subject,
      ...(params.reviewerIdentityId ? { assigneeIdentityId: params.reviewerIdentityId } : {}),
      ...(params.extraReviewRequirements
        ? { extraRequirements: params.extraReviewRequirements }
        : {}),
    })
);

export const GRAPH_TEMPLATES: Record<string, GraphTemplate> = {
  [prShipTemplate.id]: prShipTemplate as GraphTemplate,
  [specShipTemplate.id]: specShipTemplate as GraphTemplate,
  [visualSignoffTemplate.id]: visualSignoffTemplate,
  [siblingReviewTemplate.id]: siblingReviewTemplate,
};

export function getGraphTemplate(id: string): GraphTemplate | null {
  return GRAPH_TEMPLATES[id] ?? null;
}

export function listGraphTemplates(): Array<{
  id: string;
  version: string;
  summary: string;
  injectable: boolean;
}> {
  return Object.values(GRAPH_TEMPLATES).map((template) => ({
    id: template.id,
    version: template.version,
    summary: template.summary,
    injectable: Boolean(template.injectable),
  }));
}

/**
 * Identifies the SHAPE that was emitted, not the params that produced it —
 * two different call sites that build the same graph should hash alike, and a
 * template whose output drifts should not. Recorded on the revision so a
 * graph can be traced back to the constructor that built it.
 */
export function configHash(shape: GraphShape): string {
  return createHash('sha256').update(canonicalize(shape)).digest('hex').slice(0, 32);
}

/** Stable JSON: object keys sorted, arrays left in emission order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

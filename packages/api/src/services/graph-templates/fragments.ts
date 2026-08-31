/**
 * Composable graph fragments.
 *
 * Each fragment is a small named shape with declared entry and exit slugs, so
 * a template splices them rather than restating them. `pr-ship` is work +
 * sibling-review + visual-signoff + merge; `spec-ship` reuses two of the
 * three. A fragment is also independently instantiable — injecting
 * `visual-signoff` into a PR that grew a UI halfway through is the same call
 * that built the original shape, with a smaller input.
 */

import {
  renderRequirementChecklist,
  type GateRequirement,
  type GraphShape,
  type GraphTemplateNode,
} from './types';

/** A gate's checklist, repeated in its description so every reader sees it. */
function describeGate(intent: string, requirements: GateRequirement[]): string {
  const checklist = renderRequirementChecklist(requirements);
  return checklist ? `${intent}\n\n${checklist}` : intent;
}

/**
 * The evidence a sibling review verdict should carry. Each item earned its
 * place in a real review cycle:
 *
 * - The SHA, because "I reviewed the branch" stops being true the moment
 *   anyone pushes.
 * - Named checks rather than "CI is green", because the reader can re-run a
 *   named check and cannot re-run an adjective.
 * - The merge tree, PRE-computed. `git merge-tree --write-tree` yields the
 *   tree the merge WILL produce; recording it turns the verdict into a
 *   falsifiable pre-registration rather than an opinion. Twice now the
 *   merge has landed byte-identical to the predicted tree.
 * - The threat model, because a technically-true finding that assumes an
 *   attacker we have already accepted costs more to implement than to
 *   ignore (PR #551, 113 lines built and deleted).
 */
export function siblingReviewRequirements(subject: string): GateRequirement[] {
  return [
    {
      label: 'The exact commit you reviewed',
      detail: `full SHA of the head you actually read — not the branch name (${subject})`,
      kind: 'sha',
    },
    {
      label: 'CI checks by name, green at that SHA',
      detail: 'name each check; "CI is green" is not re-runnable by the reader',
      kind: 'check',
    },
    {
      label: 'The merge tree you predict',
      detail:
        'git merge-tree --write-tree origin/main <head> — pre-registering it makes the verdict falsifiable before the merge',
      kind: 'merge-tree',
    },
    {
      label: 'Where the review itself lives',
      detail: 'PR review URL or the thread message carrying your findings',
      kind: 'link',
    },
    {
      label: 'The threat model any security finding assumes',
      detail:
        'name the attacker a finding defends against, so a scenario we have already accepted can be recognised as one',
      kind: 'note',
    },
  ];
}

/**
 * Visual sign-off is self-reported in v1 and deliberately two-sided: the
 * honest answer for most PRs is "nothing user-visible changed", and a gate
 * that only accepts screenshots teaches people to produce decorative ones.
 * A server-side deterministic diff is the natural v2.
 */
export function visualSignoffRequirements(subject: string): GateRequirement[] {
  return [
    {
      label: 'Either: no user-visible surface changed',
      detail:
        'say so, and give the command that re-derives it (e.g. git diff --stat on the UI paths)',
      kind: 'note',
    },
    {
      label: 'Or: screenshots of what changed',
      detail:
        'real paths under ~/.ink/files/… or docs/screenshots/… — they render inline in the thread',
      kind: 'media',
    },
    {
      label: 'Where the shots are published',
      detail: `PR body embed for ${subject}, so the images outlive the thread`,
      kind: 'link',
    },
    {
      label: 'Confirmation a human actually saw them',
      detail: 'the relay receipt — a screenshot nobody looked at is not a sign-off',
      kind: 'note',
    },
  ];
}

export interface WorkFragmentOptions {
  slug?: string;
  title: string;
  description?: string;
}

/**
 * The work node. ONE node, open-ended, on purpose: the graph is not trying to
 * plan the work, only to hold the promises around it.
 */
export function workFragment(options: WorkFragmentOptions): GraphShape {
  const slug = options.slug ?? 'work';
  return {
    nodes: [
      {
        slug,
        type: 'work',
        title: options.title,
        description: options.description,
        priority: 'high',
      },
    ],
    edges: [],
  };
}

export interface GateFragmentOptions {
  slug?: string;
  subject: string;
  assigneeIdentityId?: string;
  assigneeUserId?: string;
  extraRequirements?: GateRequirement[];
  notBeforeSeconds?: number;
}

export function siblingReviewFragment(options: GateFragmentOptions): GraphShape {
  const slug = options.slug ?? 'sibling-review';
  const requirements = [
    ...siblingReviewRequirements(options.subject),
    ...(options.extraRequirements ?? []),
  ];
  const node: GraphTemplateNode = {
    slug,
    type: 'verification',
    title: `Sibling review — ${options.subject}`,
    description: describeGate(
      `An independent sibling reviews ${options.subject} and records a verdict. ` +
        'You are not the author; that is the point of this gate.',
      requirements
    ),
    priority: 'high',
    ...(options.assigneeIdentityId ? { assigneeIdentityId: options.assigneeIdentityId } : {}),
    ...(options.assigneeUserId ? { assigneeUserId: options.assigneeUserId } : {}),
    verification: {
      mode: 'executable',
      requirements,
      ...(options.notBeforeSeconds ? { notBeforeSeconds: options.notBeforeSeconds } : {}),
    },
  };
  return { nodes: [node], edges: [] };
}

export function visualSignoffFragment(options: GateFragmentOptions): GraphShape {
  const slug = options.slug ?? 'visual-signoff';
  const requirements = [
    ...visualSignoffRequirements(options.subject),
    ...(options.extraRequirements ?? []),
  ];
  // Approval mode when a human holds it: humans are assignees and verdict
  // actors, never claimants (spec principle 9).
  const mode = options.assigneeUserId ? 'approval' : 'executable';
  const node: GraphTemplateNode = {
    slug,
    type: 'verification',
    title: `Visual sign-off — ${options.subject}`,
    description: describeGate(
      `Confirm what ${options.subject} looks like to a person, or state plainly that ` +
        'nothing user-visible changed.',
      requirements
    ),
    priority: 'high',
    ...(options.assigneeIdentityId ? { assigneeIdentityId: options.assigneeIdentityId } : {}),
    ...(options.assigneeUserId ? { assigneeUserId: options.assigneeUserId } : {}),
    verification: { mode, requirements },
  };
  return { nodes: [node], edges: [] };
}

export interface MergeFragmentOptions {
  slug?: string;
  subject: string;
}

export function mergeFragment(options: MergeFragmentOptions): GraphShape {
  const slug = options.slug ?? 'merge';
  return {
    nodes: [
      {
        slug,
        type: 'work',
        title: `Merge ${options.subject}`,
        description:
          `Merge ${options.subject} once every gate above has passed. ` +
          'Merge commit, never squash. Claim and complete this node in the same turn — ' +
          'claims release at the turn boundary.',
        priority: 'high',
      },
    ],
    edges: [],
  };
}

/** Splice fragments into one shape, concatenating nodes and edges. */
export function composeShapes(...shapes: GraphShape[]): GraphShape {
  return {
    nodes: shapes.flatMap((shape) => shape.nodes),
    edges: shapes.flatMap((shape) => shape.edges),
  };
}

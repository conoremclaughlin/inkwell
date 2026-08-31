/**
 * What these tests pin down is the SHAPE a constructor emits and the wiring
 * between its parts — the two things a caller cannot see until a graph is
 * already running and wrong. They deliberately do not assert requirement
 * wording: requirements are a checklist, and a checklist that cannot be
 * reworded without breaking a test is a schema by another name.
 */

import { describe, it, expect } from 'vitest';
import {
  configHash,
  getGraphTemplate,
  listGraphTemplates,
  prShipTemplate,
  specShipTemplate,
  visualSignoffTemplate,
} from './templates';
import { renderGateChecklistBlock, renderRequirementChecklist } from './types';
import type { GraphShape } from './types';

const REVIEWER = '8d48d86c-656a-4219-8c21-9eed9fc13601';
const HUMAN = '550e8400-e29b-41d4-a716-446655440000';

const slugs = (shape: GraphShape) => shape.nodes.map((n) => n.slug);
const edgeSet = (shape: GraphShape) => shape.edges.map((e) => `${e.from}->${e.to}`).sort();
const bySlug = (shape: GraphShape, slug: string) => shape.nodes.find((n) => n.slug === slug)!;

describe('pr-ship', () => {
  it('emits work, two independent gates, and a merge that converges on both', () => {
    const shape = prShipTemplate.build({
      subject: 'PR #551',
      reviewerIdentityId: REVIEWER,
      visualSignoffUserId: HUMAN,
    });

    expect(slugs(shape).sort()).toEqual(['merge', 'sibling-review', 'visual-signoff', 'work']);
    // The gates do not depend on each other: a stalled visual sign-off must
    // never block the code review from being recorded, and neither gate on
    // its own may let the merge through.
    expect(edgeSet(shape)).toEqual([
      'sibling-review->merge',
      'visual-signoff->merge',
      'work->sibling-review',
      'work->visual-signoff',
    ]);
  });

  it('keeps the work as ONE open-ended node — the template holds promises, not a plan', () => {
    const shape = prShipTemplate.build({ subject: 'PR #551', reviewerIdentityId: REVIEWER });
    expect(shape.nodes.filter((n) => n.type === 'work').map((n) => n.slug)).toEqual([
      'work',
      'merge',
    ]);
  });

  it('gives every gate exactly one principal — the DB CHECK refuses anything else', () => {
    const shape = prShipTemplate.build({
      subject: 'PR #551',
      reviewerIdentityId: REVIEWER,
      visualSignoffUserId: HUMAN,
    });
    for (const gate of shape.nodes.filter((n) => n.type === 'verification')) {
      expect(Boolean(gate.assigneeIdentityId) !== Boolean(gate.assigneeUserId)).toBe(true);
    }
    expect(bySlug(shape, 'sibling-review').assigneeIdentityId).toBe(REVIEWER);
    expect(bySlug(shape, 'visual-signoff').assigneeUserId).toBe(HUMAN);
  });

  it('a human visual signer gets an approval gate; an SB gets an executable one', () => {
    const human = prShipTemplate.build({ subject: 'x', visualSignoffUserId: HUMAN });
    expect(bySlug(human, 'visual-signoff').verification?.mode).toBe('approval');

    const sb = prShipTemplate.build({ subject: 'x', visualSignoffIdentityId: REVIEWER });
    expect(bySlug(sb, 'visual-signoff').verification?.mode).toBe('executable');
  });

  it('drops the visual gate AND its edges when the change has no visible surface', () => {
    const shape = prShipTemplate.build({
      subject: 'PR #551',
      reviewerIdentityId: REVIEWER,
      includeVisualSignoff: false,
    });
    expect(slugs(shape)).not.toContain('visual-signoff');
    // A dangling edge to a node that was never emitted would be refused by
    // add_graph_nodes as unknown-node — the whole instantiation, not just
    // the gate, would fail.
    expect(edgeSet(shape)).toEqual(['sibling-review->merge', 'work->sibling-review']);
  });

  it('carries the reviewer checklist onto the gate, and into its description', () => {
    const shape = prShipTemplate.build({ subject: 'PR #551', reviewerIdentityId: REVIEWER });
    const gate = bySlug(shape, 'sibling-review');
    const requirements = gate.verification?.requirements ?? [];
    expect(requirements.length).toBeGreaterThan(0);
    // Every requirement is readable without opening the JSON.
    for (const requirement of requirements) {
      expect(gate.description).toContain(requirement.label);
    }
  });

  it('appends caller requirements without displacing the defaults', () => {
    const base = prShipTemplate.build({ subject: 'x', reviewerIdentityId: REVIEWER });
    const extended = prShipTemplate.build({
      subject: 'x',
      reviewerIdentityId: REVIEWER,
      extraReviewRequirements: [{ label: 'Check the migration is reversible' }],
    });
    const baseCount = bySlug(base, 'sibling-review').verification!.requirements.length;
    const extendedRequirements = bySlug(extended, 'sibling-review').verification!.requirements;
    expect(extendedRequirements).toHaveLength(baseCount + 1);
    expect(extendedRequirements[extendedRequirements.length - 1].label).toBe(
      'Check the migration is reversible'
    );
  });
});

describe('spec-ship', () => {
  it('reuses the review obligation and replaces merge with publish, no visual gate', () => {
    const shape = specShipTemplate.build({ subject: 'spec:foo', reviewerIdentityId: REVIEWER });
    expect(slugs(shape).sort()).toEqual(['publish', 'sibling-review', 'work']);
    expect(edgeSet(shape)).toEqual(['sibling-review->publish', 'work->sibling-review']);
    // Same fragment, same checklist — the review obligation is not restated
    // per template.
    const prShip = prShipTemplate.build({ subject: 'spec:foo', reviewerIdentityId: REVIEWER });
    expect(bySlug(shape, 'sibling-review').verification).toEqual(
      bySlug(prShip, 'sibling-review').verification
    );
  });
});

describe('injectable fragments', () => {
  it('splices between two anchors, so the downstream node now waits on the gate', () => {
    const shape = visualSignoffTemplate.build({
      subject: 'PR #551',
      visualSignoffUserId: HUMAN,
      after: 'work',
      before: 'merge',
    });
    expect(slugs(shape)).toEqual(['visual-signoff']);
    expect(edgeSet(shape)).toEqual(['visual-signoff->merge', 'work->visual-signoff']);
  });

  it('accepts raw task UUIDs as anchors — an injection attaches to nodes with no slug', () => {
    const anchor = '41c0fedb-51cb-4b30-9852-0ac6d28c4488';
    const shape = visualSignoffTemplate.build({
      subject: 'x',
      visualSignoffUserId: HUMAN,
      after: anchor,
    });
    expect(edgeSet(shape)).toEqual([`${anchor}->visual-signoff`]);
  });

  it('emits a bare node when neither anchor is given — the caller wires it later', () => {
    const shape = visualSignoffTemplate.build({ subject: 'x', visualSignoffUserId: HUMAN });
    expect(shape.edges).toEqual([]);
  });

  it('is registered as injectable, so the tool can refuse a group-less call', () => {
    expect(visualSignoffTemplate.injectable).toBe(true);
    expect(prShipTemplate.injectable).toBeUndefined();
  });
});

describe('registry', () => {
  it('resolves known ids and refuses unknown ones', () => {
    expect(getGraphTemplate('pr-ship')).toBe(prShipTemplate);
    expect(getGraphTemplate('nope')).toBeNull();
  });

  it('lists every registered template with its version', () => {
    const listed = listGraphTemplates();
    expect(listed.map((t) => t.id).sort()).toEqual([
      'pr-ship',
      'sibling-review',
      'spec-ship',
      'visual-signoff',
    ]);
    for (const entry of listed) expect(entry.version).toBeTruthy();
  });
});

describe('configHash', () => {
  it('identifies the emitted shape, not the object identity', () => {
    const params = { subject: 'PR #551', reviewerIdentityId: REVIEWER };
    expect(configHash(prShipTemplate.build(params))).toBe(configHash(prShipTemplate.build(params)));
  });

  it('is insensitive to key order but sensitive to content', () => {
    const a: GraphShape = { nodes: [{ slug: 's', type: 'work', title: 't' }], edges: [] };
    const b: GraphShape = { nodes: [{ title: 't', type: 'work', slug: 's' }], edges: [] };
    expect(configHash(a)).toBe(configHash(b));

    const c: GraphShape = { nodes: [{ slug: 's', type: 'work', title: 'CHANGED' }], edges: [] };
    expect(configHash(c)).not.toBe(configHash(a));
  });

  it('changes when the shape changes, so a drifting constructor is traceable', () => {
    const withVisual = configHash(prShipTemplate.build({ subject: 'x' }));
    const without = configHash(prShipTemplate.build({ subject: 'x', includeVisualSignoff: false }));
    expect(withVisual).not.toBe(without);
  });
});

describe('renderRequirementChecklist', () => {
  it('renders one unchecked box per requirement, detail after an em dash', () => {
    expect(
      renderRequirementChecklist([
        { label: 'The exact commit you reviewed', detail: 'full SHA' },
        { label: 'Screenshots' },
      ])
    ).toBe(
      'This gate is asking for:\n  [ ] The exact commit you reviewed — full SHA\n  [ ] Screenshots'
    );
  });

  it('renders nothing for a gate with no requirements', () => {
    expect(renderRequirementChecklist([])).toBe('');
  });
});

/**
 * The reminder has to survive the trip from a constructor, through JSONB, to
 * the message that wakes the assignee. These cases are what that block sees
 * in practice: hand-authored gates, gates from an older constructor, and the
 * template's own output.
 */
describe('renderGateChecklistBlock', () => {
  it("carries the template's checklist into the gate-open message", () => {
    const gate = bySlug(
      prShipTemplate.build({ subject: 'PR #551', reviewerIdentityId: REVIEWER }),
      'sibling-review'
    );
    const block = renderGateChecklistBlock(gate.verification);
    for (const requirement of gate.verification!.requirements) {
      expect(block).toContain(requirement.label);
    }
    // The reader is told these are a checklist, not a schema — the whole
    // point of the ruling this feature is built on.
    expect(block).toContain('not a schema');
  });

  it('adds nothing when there is nothing to say', () => {
    expect(renderGateChecklistBlock(null)).toBe('');
    expect(renderGateChecklistBlock(undefined)).toBe('');
    expect(renderGateChecklistBlock({})).toBe('');
    expect(renderGateChecklistBlock({ requirements: [] })).toBe('');
    // A gate authored before requirements existed, or by hand.
    expect(renderGateChecklistBlock({ mode: 'approval', notBeforeSeconds: 60 })).toBe('');
  });

  it('skips malformed entries rather than breaking the dispatch', () => {
    const block = renderGateChecklistBlock({
      requirements: [
        null,
        'a bare string',
        { detail: 'no label' },
        { label: '  ' },
        { label: 'ok' },
      ],
    });
    expect(block).toContain('[ ] ok');
    expect(block).not.toContain('a bare string');
    expect(block).not.toContain('no label');
    expect(block.match(/\[ \]/g)).toHaveLength(1);
  });

  it('renders nothing when every entry is malformed', () => {
    expect(renderGateChecklistBlock({ requirements: [null, 42, { nope: true }] })).toBe('');
  });

  it('tolerates requirements that are not an array at all', () => {
    expect(renderGateChecklistBlock({ requirements: 'see the PR' })).toBe('');
  });
});

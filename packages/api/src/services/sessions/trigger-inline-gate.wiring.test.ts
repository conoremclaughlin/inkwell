import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Source-level pin of the wiring behind decideDelivery's `ownGate`. The
 * decision itself is unit-tested in trigger-delivery.test.ts. What a unit test
 * can't reach is that the trigger handler knows the target is an inkling,
 * from the identity row it already reads, on every branch that resolves one,
 * and hands that to the decision. Without it, a CLI attached to an inkling's
 * session would receive its wakes and skip the owner test and the profile
 * (Oct 7 audit, suspected #1).
 */
const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');

describe('the trigger handler tells decideDelivery when the target is an inkling', () => {
  it('reads the identity metadata on both resolution branches', () => {
    expect(source).toContain(".select('id, agent_id, workspace_id, metadata')");
    expect(source).toContain(".select('id, workspace_id, metadata')");
  });

  it('records the target metadata on all three ways the identity is resolved', () => {
    expect(source).toContain('targetMetadata = identityRow.metadata;');
    expect(source).toContain('targetMetadata = workspaceScoped[0].metadata;');
    expect(source).toContain('targetMetadata = identityRows[0].metadata;');
    expect(source.match(/targetMetadata = [\w\[\]0.]+\.metadata;/g)).toHaveLength(3);
  });

  it('passes it to the one delivery decision', () => {
    expect(source.match(/decideDelivery\(\{/g)).toHaveLength(1);
    expect(source).toMatch(
      /decideDelivery\(\{\s*forceSpawn,\s*pollRow,\s*attachedRow,\s*targetMetadata,\s*\}\)/
    );
  });
});

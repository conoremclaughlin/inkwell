/**
 * .ink/identity.json is read in more than one place, and readIdentityJson is
 * NOT the funnel I assumed it was.
 *
 * studio (list, default CLI name, branch-rename planning), doctor, and the
 * channel plugin each parse the file themselves. Normalizing inside
 * readIdentityJson therefore covered none of them, and a legacy
 * `{ agentId: 'aster' }` file silently produced the wrong name or no plan at
 * all (Lumen, PR #635). These drive the shared normalizer and the one planner
 * whose behaviour actually changed.
 */
import { describe, expect, it } from 'vitest';
import { normalizeIdentityJson } from './identity.js';
import { planStudioHomeBranchRename } from '../commands/studio.js';

describe('normalizeIdentityJson', () => {
  it('fills sbSlug from a legacy agentId', () => {
    expect(normalizeIdentityJson({ agentId: 'aster', studio: 'dev' })).toMatchObject({
      sbSlug: 'aster',
      agentId: 'aster',
      studio: 'dev',
    });
  });

  it('leaves a current-format object untouched', () => {
    const current = { sbSlug: 'wren', studio: 'dev' };
    expect(normalizeIdentityJson(current)).toBe(current);
  });

  it('prefers an existing sbSlug over a stale agentId', () => {
    expect(normalizeIdentityJson({ sbSlug: 'wren', agentId: 'aster' }).sbSlug).toBe('wren');
  });

  it('keeps every other key, because callers read more than the slug', () => {
    // studio's rename path reads branch/studioId/context off the same object.
    const out = normalizeIdentityJson({
      agentId: 'aster',
      branch: 'aster/studio/dev',
      studioId: 's-1',
      context: 'studio-dev',
    });
    expect(out).toMatchObject({
      sbSlug: 'aster',
      branch: 'aster/studio/dev',
      studioId: 's-1',
      context: 'studio-dev',
    });
  });

  it('passes non-objects through rather than throwing', () => {
    // Control: a corrupt file must not become a crash in every reader.
    expect(normalizeIdentityJson(null)).toBeNull();
    expect(normalizeIdentityJson(undefined)).toBeUndefined();
    expect(normalizeIdentityJson('nonsense')).toBe('nonsense');
  });
});

describe('planStudioHomeBranchRename with a pre-rename identity file', () => {
  // The planner only fires when branch is the studio's default for 'from':
  // `${slug}/studio/main-${studio}` (or the legacy `${slug}/studio/main`).
  const legacy = { agentId: 'aster', branch: 'aster/studio/main-dev' };

  it('plans the rename once the legacy key is normalized', () => {
    const plan = planStudioHomeBranchRename(normalizeIdentityJson(legacy), 'dev', 'prod');

    expect(plan).not.toBeNull();
    expect(plan?.fromBranch).toBe('aster/studio/main-dev');
  });

  it('returns null WITHOUT normalization, which is the defect', () => {
    // Drives the guard directly: `if (!identity.sbSlug ...) return null`. An
    // un-normalized legacy file hits it, and default-branch renaming just stops
    // happening — no error, no log.
    expect(planStudioHomeBranchRename(legacy as never, 'dev', 'prod')).toBeNull();
  });

  it('still returns null for an identity with no branch at all', () => {
    // Control: normalization does not make the planner fire on nothing.
    expect(
      planStudioHomeBranchRename(normalizeIdentityJson({ agentId: 'aster' }), 'dev', 'prod')
    ).toBeNull();
  });
});

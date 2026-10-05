// @vitest-environment jsdom
/**
 * ParticipantCluster has to lay out the same in every parent that shows it.
 * jsdom loads no Tailwind, so what this measures is the element's own
 * default display, the one a plain block parent leaves it with.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ParticipantCluster } from './thread-list';

afterEach(cleanup);

describe('ParticipantCluster', () => {
  it("keeps a group's box in a plain block parent, as the conversation's opening lines are", () => {
    // Before the fix the root was an inline span: in a block it collapsed to
    // nothing, and the absolutely placed avatars spilled out of the pane and
    // over the title (Conor, 2026-10-02).
    const { container } = render(
      <div>
        <ParticipantCluster participants={['myra', 'wren']} nameFor={(slug) => slug} />
      </div>
    );
    const cluster = container.firstElementChild?.firstElementChild as HTMLElement;
    expect(cluster.className).toContain('h-10 w-10');
    expect(getComputedStyle(cluster).display).not.toBe('inline');
  });

  it('leaves the display to a caller that sets one, as the conversation header does', () => {
    const { container } = render(
      <ParticipantCluster
        participants={['myra', 'wren', 'lumen']}
        nameFor={(slug) => slug}
        className="hidden sm:flex"
      />
    );
    const cluster = container.firstElementChild as HTMLElement;
    expect(cluster.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'sm:flex']));
    expect(cluster.textContent).toContain('+1');
  });
});

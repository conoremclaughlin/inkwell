import { describe, it, expect } from 'vitest';
import { parseLinkTarget, specTwin } from './thread-links';

describe('parseLinkTarget', () => {
  it('reads an ink:// URI as an artifact', () => {
    expect(parseLinkTarget('ink://specs/live-agent-surfaces')).toEqual({
      kind: 'artifact',
      uri: 'ink://specs/live-agent-surfaces',
    });
  });

  it('reads a thread key as a thread, project-prefixed ones included', () => {
    expect(parseLinkTarget('pr:701')).toEqual({ kind: 'thread', threadKey: 'pr:701' });
    expect(parseLinkTarget('inktrade:pr:42')).toEqual({
      kind: 'thread',
      threadKey: 'inktrade:pr:42',
    });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(parseLinkTarget('  spec:thread-media \n')).toEqual({
      kind: 'thread',
      threadKey: 'spec:thread-media',
    });
  });

  it('refuses what is neither', () => {
    for (const bad of ['pr 701', '701', ':701', 'ink://', 'https://example.com/x', 'pr:']) {
      expect(parseLinkTarget(bad), bad).toHaveProperty('error');
    }
  });

  // https:// has the type:identifier shape. It is not a thread, and storing it
  // as one would make a dangling "no thread yet" key out of a web link.
  it('does not mistake a web URL for a thread key', () => {
    expect(parseLinkTarget('https://github.com/x/y/pull/1')).toHaveProperty('error');
  });
});

describe('specTwin', () => {
  it('pairs spec:<slug> with ink://specs/<slug>, both ways', () => {
    expect(specTwin({ kind: 'thread', threadKey: 'spec:live-agent-surfaces' })).toEqual({
      kind: 'artifact',
      uri: 'ink://specs/live-agent-surfaces',
    });
    expect(specTwin({ kind: 'artifact', uri: 'ink://specs/live-agent-surfaces' })).toEqual({
      kind: 'thread',
      threadKey: 'spec:live-agent-surfaces',
    });
  });

  it('has no twin for anything that is not a spec', () => {
    expect(specTwin({ kind: 'thread', threadKey: 'pr:701' })).toBeNull();
    expect(specTwin({ kind: 'artifact', uri: 'ink://ideas/future-vision' })).toBeNull();
  });

  // A project-prefixed spec lives in another repo; the library has no URI to
  // pair it with, so joining it to ink://specs/<slug> would merge two subjects.
  it('does not join a project-prefixed spec key or a nested spec URI', () => {
    expect(specTwin({ kind: 'thread', threadKey: 'inktrade:spec:valuation' })).toBeNull();
    expect(specTwin({ kind: 'thread', threadKey: 'spec:a:b' })).toBeNull();
    expect(specTwin({ kind: 'artifact', uri: 'ink://specs/a/b' })).toBeNull();
  });
});

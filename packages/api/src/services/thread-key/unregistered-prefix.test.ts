import { describe, it, expect } from 'vitest';
import {
  detectUnregisteredProjectPrefix,
  describeUnregisteredProjectPrefix,
} from './unregistered-prefix';

// Mirrors the real registry shape: canonical slugs map to themselves, aliases
// map to the canonical slug they pin.
const SLUGS = new Map<string, string>([
  ['inkwell', 'inkwell'],
  ['inktrade', 'inktrade'],
  ['pcp', 'inkwell'],
]);

const TYPES = new Set(['pr', 'spec', 'issue', 'branch', 'task', 'debug', 'thread', 'deploy']);

describe('detectUnregisteredProjectPrefix', () => {
  it('flags a project prefix that is not registered', () => {
    const found = detectUnregisteredProjectPrefix('cnr:issue:7', SLUGS, TYPES);

    expect(found).toEqual({
      suspectedProject: 'cnr',
      pinnedAsType: 'cnr',
      pinnedAsId: 'issue:7',
    });
  });

  it('says nothing about a registered project', () => {
    expect(detectUnregisteredProjectPrefix('inktrade:pr:42', SLUGS, TYPES)).toBeNull();
  });

  it('says nothing about a registered alias', () => {
    // `pcp` resolves to inkwell — the key parses exactly as intended.
    expect(detectUnregisteredProjectPrefix('pcp:issue:7', SLUGS, TYPES)).toBeNull();
  });

  it('says nothing about a known type whose id contains a colon', () => {
    // The false positive that would make this warning worthless: three
    // segments, but the first is a real type and the rest is just the id.
    expect(detectUnregisteredProjectPrefix('thread:perf:audit', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('spec:cli:session:hooks', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('debug:inbox:latency', SLUGS, TYPES)).toBeNull();
  });

  it('says nothing about an ordinary two-segment key', () => {
    // No room for a project prefix, so nothing is ambiguous.
    expect(detectUnregisteredProjectPrefix('pr:530', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('somethingnew:1', SLUGS, TYPES)).toBeNull();
  });

  it('ignores malformed keys rather than guessing at them', () => {
    expect(detectUnregisteredProjectPrefix('', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('cnr', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix(':issue:7', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('cnr::7', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('cnr:issue:', SLUGS, TYPES)).toBeNull();
  });

  it('keeps the whole remainder as the id, colons and all', () => {
    const found = detectUnregisteredProjectPrefix('cnr:spec:a:b:c', SLUGS, TYPES);
    expect(found?.pinnedAsId).toBe('spec:a:b:c');
  });

  it('reports what the key will actually become, not just that it is wrong', () => {
    const found = detectUnregisteredProjectPrefix('cnr:issue:7', SLUGS, TYPES)!;
    const message = describeUnregisteredProjectPrefix('cnr:issue:7', found);

    // The agent needs three things to act: what it wrote, what it will become,
    // and that waiting will not help.
    expect(message).toContain('cnr');
    expect(message).toContain('issue:7');
    expect(message).toContain('cannot be changed');
    expect(message).toContain('save_project');
  });

  it('treats an empty registry as "nothing is registered", not "everything is fine"', () => {
    // A user with no projects yet still gets told their prefix will not work.
    const found = detectUnregisteredProjectPrefix('cnr:issue:7', new Map(), TYPES);
    expect(found?.suspectedProject).toBe('cnr');
  });
});

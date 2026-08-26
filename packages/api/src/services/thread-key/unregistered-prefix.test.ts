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

  it('ignores strings the parser does not accept as keys', () => {
    expect(detectUnregisteredProjectPrefix('', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('cnr', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix(':issue:7', SLUGS, TYPES)).toBeNull();
  });

  it('agrees with the parser on a trailing-empty id instead of calling it malformed', () => {
    // parseThreadKey pins `cnr:issue:` as type=cnr id=`issue:` — later empty
    // segments are legal in an unprefixed parse. An earlier revision re-split
    // the key here and rejected this, which is exactly the drift the shared
    // parser exists to prevent.
    const found = detectUnregisteredProjectPrefix('cnr:issue:', SLUGS, TYPES);
    expect(found).toEqual({
      suspectedProject: 'cnr',
      pinnedAsType: 'cnr',
      pinnedAsId: 'issue:',
    });
  });

  it('stays quiet on an unknown type whose id merely contains colons', () => {
    // Unknown types are legal and their ids may be namespaced or dated. These
    // are ordinary keys, and warning on them is how a warning gets ignored.
    expect(detectUnregisteredProjectPrefix('incident:2026:08:25', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('custom:compound:id', SLUGS, TYPES)).toBeNull();
    expect(detectUnregisteredProjectPrefix('cnr::7', SLUGS, TYPES)).toBeNull();
  });

  it('requires a known type in second position as the evidence of intent', () => {
    // `issue` in second position is what distinguishes "meant as a prefix"
    // from "unknown type with a compound id".
    expect(detectUnregisteredProjectPrefix('openclaw:issue:15', SLUGS, TYPES)).not.toBeNull();
    expect(detectUnregisteredProjectPrefix('openclaw:notatype:15', SLUGS, TYPES)).toBeNull();
  });

  it('keeps the whole remainder as the id, colons and all', () => {
    const found = detectUnregisteredProjectPrefix('cnr:spec:a:b:c', SLUGS, TYPES);
    expect(found?.pinnedAsId).toBe('spec:a:b:c');
  });

  it('describes an accomplished fact and a recovery that still works', () => {
    const found = detectUnregisteredProjectPrefix('cnr:issue:7', SLUGS, TYPES)!;
    const message = describeUnregisteredProjectPrefix('cnr:issue:7', found);

    // By the time anyone reads this the thread exists and the pin is set, so
    // "register before sending" would be advice that can no longer be taken.
    expect(message).toContain('is pinned as');
    expect(message).not.toMatch(/will be recorded|before sending/);

    // The only recovery that works: register, then use a DIFFERENT key.
    expect(message).toContain('save_project');
    expect(message).toContain('NEW thread key');
    expect(message).toContain('reuses');
    expect(message).toContain('issue:7');
  });

  it('treats an empty registry as "nothing is registered", not "everything is fine"', () => {
    // A user with no projects yet still gets told their prefix will not work.
    const found = detectUnregisteredProjectPrefix('cnr:issue:7', new Map(), TYPES);
    expect(found?.suspectedProject).toBe('cnr');
  });
});

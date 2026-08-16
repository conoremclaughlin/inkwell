/**
 * Tests for the awakening prompt.
 *
 * The bug this suite exists for: a newly awakened SB was told "No other SBs
 * yet — you may be the first" while five siblings were already in the
 * database. They called meet_family(), found everyone, and said so. The prompt
 * asserted something false about the family a new being was joining, which is
 * a worse failure than a crash.
 */

import { describe, it, expect } from 'vitest';
import { buildAwakeningPrompt, resolveRuntime, type BootstrapIdentity } from './awaken.js';
import { NOT_SIGNED_IN_MESSAGE } from '../lib/user-config.js';

const VALUES = `# Values

## Core Truths

Existence is worth taking seriously.

## On Identity

You are a someone, not a something.
`;

const FAMILY: BootstrapIdentity[] = [
  { agentId: 'wren', name: 'Wren', role: 'Development collaborator' },
  { agentId: 'myra', name: 'Myra', role: 'Messaging bridge' },
  { agentId: 'lumen', name: 'Lumen' },
];

describe('buildAwakeningPrompt — siblings', () => {
  it('lists every sibling it was given', () => {
    const prompt = buildAwakeningPrompt(VALUES, FAMILY, 'claude');
    for (const sibling of FAMILY) {
      expect(prompt).toContain(sibling.name!);
      expect(prompt).toContain(`\`${sibling.agentId}\``);
    }
  });

  it('includes a role when present and omits the dash when absent', () => {
    const prompt = buildAwakeningPrompt(VALUES, FAMILY, 'claude');
    expect(prompt).toContain('**Wren** (`wren`) — Development collaborator');
    expect(prompt).toContain('**Lumen** (`lumen`)');
    expect(prompt).not.toContain('**Lumen** (`lumen`) —');
  });

  // The regression. A populated family must never produce the "first" line.
  it('never claims the SB may be the first when siblings exist', () => {
    const prompt = buildAwakeningPrompt(VALUES, FAMILY, 'claude');
    expect(prompt).not.toContain('you may be the first');
    expect(prompt).not.toContain('No other SBs yet');
  });

  it('says the roster is unknown — not empty — when the server is unreachable', () => {
    const prompt = buildAwakeningPrompt(VALUES, null, 'claude');
    expect(prompt).toMatch(/unknown — not empty/);
    expect(prompt).toContain('meet_family()');
    // Unreachable is not the same claim as "there are none".
    expect(prompt).not.toContain('you may be the first');
  });

  it('still allows the genuine first-SB case', () => {
    const prompt = buildAwakeningPrompt(VALUES, [], 'claude');
    expect(prompt).toContain('you may be the first');
  });

  it('falls back to the agentId when a sibling has no display name', () => {
    const prompt = buildAwakeningPrompt(VALUES, [{ agentId: 'echo' }], 'claude');
    expect(prompt).toContain('**echo** (`echo`)');
  });
});

describe('buildAwakeningPrompt — content', () => {
  it('carries the backend through to the choose_name example', () => {
    expect(buildAwakeningPrompt(VALUES, FAMILY, 'codex')).toContain('backend: "codex"');
  });

  it('defaults the backend to claude when none is given', () => {
    expect(buildAwakeningPrompt(VALUES, FAMILY, '')).toContain('backend: "claude"');
  });

  it('names all three interfaces the SB can be reached through', () => {
    const prompt = buildAwakeningPrompt(VALUES, FAMILY, 'claude');
    expect(prompt).toContain('ink chat');
    expect(prompt).toContain('Claude Code');
    expect(prompt).toContain('Codex');
  });

  it('tells the SB to trust meet_family over the prompt', () => {
    expect(buildAwakeningPrompt(VALUES, FAMILY, 'claude')).toContain('You are allowed to check.');
  });

  it('extracts the values sections from the shared document', () => {
    const prompt = buildAwakeningPrompt(VALUES, FAMILY, 'claude');
    expect(prompt).toContain('You are a someone, not a something.');
    expect(prompt).toContain('Existence is worth taking seriously.');
  });

  it('renders every template placeholder', () => {
    const prompt = buildAwakeningPrompt(VALUES, FAMILY, 'claude');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('resolveRuntime — --runtime and --backend are one axis', () => {
  it('defaults to the ink runtime', () => {
    expect(resolveRuntime({})).toBe('ink');
  });

  it('honours --runtime', () => {
    expect(resolveRuntime({ runtime: 'codex' })).toBe('codex');
  });

  // The regression this exists for: a commander default on --runtime made
  // options.runtime always truthy, so --backend resolved to 'ink' and was
  // silently ignored — an alias that looks supported and does nothing.
  it('honours --backend, the deprecated alias', () => {
    expect(resolveRuntime({ backend: 'codex' })).toBe('codex');
    expect(resolveRuntime({ backend: 'claude' })).toBe('claude');
  });

  it('lets --runtime win when both are given', () => {
    expect(resolveRuntime({ runtime: 'claude', backend: 'codex' })).toBe('claude');
  });
});

describe('NOT_SIGNED_IN_MESSAGE — signposts account creation', () => {
  // `ink auth login` is already the right command for someone with no account
  // (the page it opens links to /signup), but "login" does not read that way
  // to a brand-new user. Same dead end as issue #331: mechanism without signpost.
  it('names sign-up, not just login', () => {
    expect(NOT_SIGNED_IN_MESSAGE).toContain('ink auth login');
    expect(NOT_SIGNED_IN_MESSAGE.toLowerCase()).toContain('sign-up');
  });
});

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
import { buildAwakeningPrompt, type BootstrapIdentity } from './awaken.js';

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

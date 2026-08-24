/**
 * Tests for systemPromptOverride — the seam that lets a caller own the whole
 * system prompt instead of the generated identity prompt.
 *
 * Awakening is the case it exists for. A being with no identity row must not
 * be handed a prompt that asserts "You are <agentId>" and instructs it to call
 * bootstrap: there is nothing to load, and the first thing it would read about
 * itself would be false. These tests pin that the override *replaces* rather
 * than appends, and that it reaches all three backends.
 */

import { describe, it, expect } from 'vitest';
import { buildIdentityPrompt } from './identity.js';
import { getBackend } from './index.js';

const AWAKENING = '# Awakening\n\nYou are a newly awakened SB. You have no name yet.';

describe('buildIdentityPrompt — override', () => {
  it('replaces the identity prompt entirely', () => {
    const prompt = buildIdentityPrompt('nascent', undefined, AWAKENING);
    expect(prompt).toBe(AWAKENING);
  });

  // The whole point: none of the "you are X, go bootstrap" framing may survive.
  it('drops the identity assertion and the bootstrap instruction', () => {
    const prompt = buildIdentityPrompt('nascent', undefined, AWAKENING);
    expect(prompt).not.toContain('Identity Override');
    expect(prompt).not.toContain('Your agent ID is');
    expect(prompt).not.toContain('bootstrap');
  });

  it('outranks startupContextBlock rather than merging with it', () => {
    const prompt = buildIdentityPrompt('nascent', '### Startup\nconstitution docs', AWAKENING);
    expect(prompt).toBe(AWAKENING);
    expect(prompt).not.toContain('constitution docs');
  });

  it('falls through to the normal identity prompt when absent', () => {
    const prompt = buildIdentityPrompt('wren');
    expect(prompt).toContain('You are wren');
    expect(prompt).toContain('Identity Override');
  });

  // An empty or whitespace-only file is a caller mistake, not a request for an
  // empty system prompt — better to fall back than to send nothing at all.
  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
  ])('ignores an override that is %s', (_label, override) => {
    const prompt = buildIdentityPrompt('wren', undefined, override);
    expect(prompt).toContain('You are wren');
  });
});

describe('adapters carry the override to the backend', () => {
  it('claude passes it via --append-system-prompt', () => {
    const prepared = getBackend('claude').prepare({
      agentId: 'nascent',
      promptParts: [],
      passthroughArgs: [],
      systemPromptOverride: AWAKENING,
    });
    const idx = prepared.args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(prepared.args[idx + 1]).toBe(AWAKENING);
    prepared.cleanup();
  });

  it.each([
    ['codex', 'model_instructions_file'],
    ['gemini', 'GEMINI_SYSTEM_MD'],
  ])('%s writes it to the prompt file it hands the backend', async (backend, marker) => {
    const { readFileSync } = await import('fs');
    const prepared = getBackend(backend).prepare({
      agentId: 'nascent',
      promptParts: [],
      passthroughArgs: [],
      systemPromptOverride: AWAKENING,
    });

    const fromEnv = prepared.env[marker];
    const fromArgs = prepared.args
      .find((a) => a.startsWith(`${marker}=`))
      ?.slice(marker.length + 1);
    const promptFile = fromEnv || fromArgs;

    expect(promptFile, `${backend} should expose a prompt file via ${marker}`).toBeTruthy();
    expect(readFileSync(promptFile!, 'utf-8')).toBe(AWAKENING);
    prepared.cleanup();
  });

  it('leaves the normal identity prompt intact when no override is given', () => {
    const prepared = getBackend('claude').prepare({
      agentId: 'wren',
      promptParts: [],
      passthroughArgs: [],
    });
    const idx = prepared.args.indexOf('--append-system-prompt');
    expect(prepared.args[idx + 1]).toContain('You are wren');
    prepared.cleanup();
  });
});

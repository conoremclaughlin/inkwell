/**
 * An unnamed inkling's stored name is a placeholder ("Unnamed inkling"), and
 * its soul tells it it may not have a name yet. The prompts that tell an SB
 * who it is must agree: until the person names it, it is "an inkling who
 * hasn't been named yet", never the placeholder (review bbbbba99, P2 2).
 *
 * The identity row comes from the real awakening (InklingService over the
 * in-memory database), so the flag the prompts read is the one awakening
 * actually stores.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { InklingService } from './inkling-service';
import { formatInjectedContext, mapAgentIdentity } from '../sessions/context-builder';
import { buildIdentityPrompt } from '../sessions/claude-runner';
import type { InjectedContext } from '../sessions/types';
import { createInklingDb } from '../../test/fake-inkling-db';
import { bootstrapAgentInfo } from '../../mcp/tools/memory-handlers';
import { nameOf } from '../identity-name';

describe('what bootstrap and the identity reads say an inkling is called (review edf2c819)', () => {
  it('bootstrap gives an unnamed inkling no name, says so, and never the placeholder', async () => {
    const row = (await awakenedRow()) as Record<string, unknown>;
    const info = bootstrapAgentInfo(row);
    expect(info.name).toBeNull();
    expect(info.naming).toMatch(/haven't been named yet/);
    expect(JSON.stringify(info)).not.toContain('Unnamed inkling');
    // The same rule at get_identity, list_identities and meet_family.
    expect(nameOf(row as { name: string; metadata?: unknown })).toBeNull();
  });

  it('once named, bootstrap and the identity reads say its name', async () => {
    const row = (await awakenedRow('Pip')) as Record<string, unknown>;
    expect(bootstrapAgentInfo(row)).toEqual({ name: 'Pip', role: 'Inkling', capabilities: [] });
    expect(nameOf(row as { name: string; metadata?: unknown })).toBe('Pip');
  });

  it('an SB with no naming flag keeps its stored name everywhere', () => {
    const myra = { name: 'Myra', role: 'Personal SB', capabilities: [], metadata: {} };
    expect(bootstrapAgentInfo(myra).name).toBe('Myra');
    expect(nameOf(myra)).toBe('Myra');
  });
});

const ME = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
};

async function awakenedRow(name?: string) {
  const db = createInklingDb();
  const service = new InklingService(db as unknown as SupabaseClient, {
    ownerTestUserIds: new Set([ME.userId]),
  });
  const { inkling } = await service.awaken(ME, '0b6f3c1e-5d1a-4a8e-9c1b-6f0e2d3c4b5a');
  if (name) await service.name(ME, inkling.id, name);
  const row = db.rows('agent_identities').find((r) => r.id === inkling.id)!;
  // The columns the mapper reads that awakening leaves at their defaults.
  return { values: [], capabilities: [], relationships: {}, ...row } as never;
}

function promptsFor(agent: ReturnType<typeof mapAgentIdentity>): string[] {
  const context: InjectedContext = {
    agent,
    user: { id: ME.userId, timezone: 'America/Los_Angeles', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '9:00 AM PDT',
      currentDate: 'Friday, October 2, 2026',
      dayOfWeek: 'Friday',
      timezone: 'America/Los_Angeles',
      greeting: 'Good morning',
    },
    recentMemories: [],
    activeProjects: [],
  };
  return [
    formatInjectedContext(context),
    buildIdentityPrompt(agent.sbSlug, agent.unnamed ? null : agent.name, agent.soul),
  ];
}

describe('the identity line for an inkling', () => {
  it('a freshly awakened inkling is told it has not been named, never the placeholder', async () => {
    const agent = mapAgentIdentity(await awakenedRow());
    expect(agent.unnamed).toBe(true);
    for (const prompt of promptsFor(agent)) {
      expect(prompt).not.toContain('Unnamed inkling');
      expect(prompt).toContain("an inkling who hasn't been named yet");
    }
  });

  it('once named, it is told its name', async () => {
    const agent = mapAgentIdentity(await awakenedRow('Pip'));
    expect(agent.unnamed).toBeUndefined();
    const [context, identity] = promptsFor(agent);
    expect(context).toContain('You are **Pip**');
    expect(identity).toContain('You are Pip.');
  });

  it('an SB with no naming flag at all (Myra, Wren) keeps its name as before', () => {
    const agent = mapAgentIdentity({
      agent_id: 'myra',
      name: 'Myra',
      role: 'Personal SB',
      metadata: {},
      values: [],
      capabilities: [],
      relationships: {},
    } as never);
    expect(agent.unnamed).toBeUndefined();
    expect(promptsFor(agent)[0]).toContain('You are **Myra**');
  });
});

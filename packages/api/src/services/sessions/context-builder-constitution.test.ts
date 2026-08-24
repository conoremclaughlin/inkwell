/**
 * Automated sessions must receive the same constitution and the same memory
 * selection that `bootstrap` gives a hook-driven session.
 *
 * Antigravity has no session-start hook at all, so for Aster this injected
 * block is the entire context — a gap here is not a degraded session, it is an
 * agent running on its soul document alone.
 */

import { describe, it, expect } from 'vitest';
import { ContextBuilder, formatInjectedContext } from './context-builder.js';
import { makeFakeSupabase, type Row } from './fake-supabase.js';
import type { InjectedContext, Session } from './types.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';

function baseContext(overrides: Partial<InjectedContext> = {}): InjectedContext {
  return {
    agent: {
      agentId: 'aster',
      name: 'Aster',
      role: 'Development collaborator',
      values: [],
      capabilities: [],
      relationships: {},
      ...(overrides.agent || {}),
    },
    user: { id: USER_ID, timezone: 'America/Los_Angeles', contacts: {}, preferences: {} },
    temporal: {
      currentTime: '9:00 AM PST',
      currentDate: 'Monday, August 24, 2026',
      dayOfWeek: 'Monday',
      timezone: 'America/Los_Angeles',
      greeting: 'Good morning',
    },
    recentMemories: [],
    activeProjects: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: USER_ID,
    agentId: 'aster',
    backendSessionId: null,
    type: 'primary',
    lifecycle: 'running',
    status: 'active',
    contextTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    compactionCount: 0,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    endedAt: null,
    ...overrides,
  } as Session;
}

describe('formatInjectedContext — constitution', () => {
  it('renders values, process, and the user doc', () => {
    const out = formatInjectedContext(
      baseContext({
        agent: { ...baseContext().agent, soul: 'SOUL-BODY' },
        constitution: { values: 'VALUES-BODY', process: 'PROCESS-BODY', user: 'USER-BODY' },
      })
    );

    expect(out).toContain('SOUL-BODY');
    expect(out).toContain('VALUES-BODY');
    expect(out).toContain('PROCESS-BODY');
    expect(out).toContain('USER-BODY');
  });

  it('leaves the heartbeat to the system prompt', () => {
    // buildIdentityPrompt already puts the heartbeat in appendSystemPrompt,
    // where it survives compaction. Rendering it here too would ship the whole
    // document twice.
    const out = formatInjectedContext(
      baseContext({ agent: { ...baseContext().agent, heartbeat: 'HEARTBEAT-BODY' } })
    );

    expect(out).not.toContain('HEARTBEAT-BODY');
  });

  it('omits each section it has no content for', () => {
    const out = formatInjectedContext(baseContext());
    expect(out).not.toContain('## Values');
    expect(out).not.toContain('## Process');
    expect(out).not.toContain('## About Your Human');
  });
});

describe('ContextBuilder.buildContext — constitution', () => {
  const identityRow: Row = {
    id: 'sb-1',
    user_id: USER_ID,
    agent_id: 'aster',
    name: 'Aster',
    role: 'Development collaborator',
    description: null,
    soul: 'SOUL-BODY',
    heartbeat: 'HEARTBEAT-BODY',
    values: [],
    capabilities: [],
    relationships: {},
    workspace_id: 'ws-1',
    updated_at: '2026-08-01T00:00:00Z',
  };
  const userRow: Row = { id: USER_ID, timezone: 'America/Los_Angeles', preferences: {} };

  it('pulls values/process from the personal workspace and the user doc from user_identity', async () => {
    const supabase = makeFakeSupabase({
      agent_identities: [identityRow],
      users: [userRow],
      contacts: [],
      memories: [],
      projects: [],
      workspaces: [
        {
          id: 'ws-1',
          user_id: USER_ID,
          type: 'personal',
          archived_at: null,
          shared_values: 'VALUES-BODY',
          process: 'PROCESS-BODY',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      user_identity: [
        {
          user_id: USER_ID,
          user_profile_md: 'USER-BODY',
          shared_values_md: 'legacy-values',
          process_md: 'legacy-process',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());

    expect(ctx.constitution?.values).toBe('VALUES-BODY');
    expect(ctx.constitution?.process).toBe('PROCESS-BODY');
    expect(ctx.constitution?.user).toBe('USER-BODY');
  });

  it('falls back to the legacy user_identity docs when the workspace has none', async () => {
    const supabase = makeFakeSupabase({
      agent_identities: [identityRow],
      users: [userRow],
      contacts: [],
      memories: [],
      projects: [],
      workspaces: [
        {
          id: 'ws-1',
          user_id: USER_ID,
          type: 'personal',
          archived_at: null,
          shared_values: null,
          process: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      user_identity: [
        {
          user_id: USER_ID,
          user_profile_md: 'USER-BODY',
          shared_values_md: 'LEGACY-VALUES',
          process_md: 'LEGACY-PROCESS',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());

    expect(ctx.constitution?.values).toBe('LEGACY-VALUES');
    expect(ctx.constitution?.process).toBe('LEGACY-PROCESS');
  });

  it('leaves constitution undefined when the database has no docs', async () => {
    const supabase = makeFakeSupabase({
      agent_identities: [identityRow],
      users: [userRow],
      contacts: [],
      memories: [],
      projects: [],
      workspaces: [],
      user_identity: [],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());
    expect(ctx.constitution).toBeUndefined();
  });
});

describe('ContextBuilder.buildContext — memory selection', () => {
  function memoryRow(
    over: Partial<Row> & { id: string; salience: string; created_at: string }
  ): Row {
    return {
      user_id: USER_ID,
      agent_id: 'aster',
      content: `content-${over.id}`,
      source: 'observation',
      topics: [],
      metadata: {},
      version: 1,
      expires_at: null,
      contact_id: null,
      topic_key: null,
      summary: null,
      embedding: null,
      ...over,
    };
  }

  it('surfaces an old critical memory that a "10 newest" query would bury', async () => {
    // Twelve fresh low-salience notes — the kind a session writes constantly —
    // plus one old critical memory. Recency alone drops the critical one.
    const rows: Row[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(
        memoryRow({
          id: `noise-${i}`,
          salience: 'low',
          created_at: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
        })
      );
    }
    rows.push(
      memoryRow({ id: 'old-critical', salience: 'critical', created_at: '2026-03-01T00:00:00Z' })
    );

    const supabase = makeFakeSupabase({
      agent_identities: [
        {
          id: 'sb-1',
          user_id: USER_ID,
          agent_id: 'aster',
          name: 'Aster',
          role: 'dev',
          values: [],
          capabilities: [],
          relationships: {},
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      users: [{ id: USER_ID, timezone: 'UTC', preferences: {} }],
      contacts: [],
      memories: rows,
      projects: [],
      workspaces: [],
      user_identity: [],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());
    const ids = ctx.recentMemories.map((m) => m.id);

    expect(ids).toContain('old-critical');
    expect(ids[0]).toBe('old-critical');
  });

  it('caps the critical tier at 30 even when far more exist', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 45; i += 1) {
      rows.push(
        memoryRow({
          id: `crit-${i}`,
          salience: 'critical',
          created_at: `2026-0${1 + (i % 8)}-01T00:00:0${i % 10}Z`,
        })
      );
    }

    const supabase = makeFakeSupabase({
      agent_identities: [
        {
          id: 'sb-1',
          user_id: USER_ID,
          agent_id: 'aster',
          name: 'Aster',
          role: 'dev',
          values: [],
          capabilities: [],
          relationships: {},
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      users: [{ id: USER_ID, timezone: 'UTC', preferences: {} }],
      contacts: [],
      memories: rows,
      projects: [],
      workspaces: [],
      user_identity: [],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());
    expect(ctx.recentMemories).toHaveLength(30);
  });

  it('lets thread relevance outrank recency inside the critical tier', async () => {
    // The tie-break the old code had no way to express: an older memory about
    // the thread we are actually on beats a newer critical memory about
    // something else.
    const rows: Row[] = [
      memoryRow({
        id: 'on-thread',
        salience: 'critical',
        created_at: '2026-06-01T00:00:00Z',
        topics: ['pr:527'],
      }),
      memoryRow({ id: 'off-thread', salience: 'critical', created_at: '2026-08-20T00:00:00Z' }),
    ];

    const supabase = makeFakeSupabase({
      agent_identities: [
        {
          id: 'sb-1',
          user_id: USER_ID,
          agent_id: 'aster',
          name: 'Aster',
          role: 'dev',
          values: [],
          capabilities: [],
          relationships: {},
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      users: [{ id: USER_ID, timezone: 'UTC', preferences: {} }],
      contacts: [],
      memories: rows,
      projects: [],
      workspaces: [],
      user_identity: [],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(
      USER_ID,
      'aster',
      makeSession({ threadKey: 'pr:527' })
    );

    expect(ctx.recentMemories[0].id).toBe('on-thread');
  });

  it('renders memories through the budgeted digest, not as a raw dump', async () => {
    // 80 raw memory bodies once pushed a single injected block past 170KB.
    const rows: Row[] = [];
    for (let i = 0; i < 40; i += 1) {
      rows.push(
        memoryRow({
          id: `crit-${i}`,
          salience: 'critical',
          content: 'C'.repeat(4000),
          created_at: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`,
        })
      );
    }

    const supabase = makeFakeSupabase({
      agent_identities: [
        {
          id: 'sb-1',
          user_id: USER_ID,
          agent_id: 'aster',
          name: 'Aster',
          role: 'dev',
          values: [],
          capabilities: [],
          relationships: {},
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      users: [{ id: USER_ID, timezone: 'UTC', preferences: {} }],
      contacts: [],
      memories: rows,
      projects: [],
      workspaces: [],
      user_identity: [],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());
    const block = formatInjectedContext(ctx);

    expect(ctx.knowledgeSummary).toBeTruthy();
    // Raw would be 40 x 4000 = 160KB. The digest is budget-capped.
    expect(block.length).toBeLessThan(20_000);
    expect(block).toContain('## What You Know');
  });

  it('keeps an on-thread critical in the RENDERED digest, not just the ranked array', async () => {
    // The array being ranked correctly is not the property that matters — the
    // digest is what reaches the model. buildKnowledgeSummary used to regroup
    // by topic and re-sort by topic recency, so a top-ranked older memory could
    // be ranked first and still be cut from the 8KB prompt.
    const rows: Row[] = [
      memoryRow({
        id: 'on-thread',
        salience: 'critical',
        created_at: '2026-01-05T00:00:00Z',
        topics: ['pr:527'],
        content: 'THE-ANSWER-IS-HERE'.padEnd(900, '.'),
      }),
    ];
    for (let i = 0; i < 29; i += 1) {
      rows.push(
        memoryRow({
          id: `newer-${i}`,
          salience: 'critical',
          created_at: `2026-08-${String(1 + i).padStart(2, '0')}T00:00:00Z`,
          topics: [`unrelated:topic-${i}`],
          content: `filler-${i}`.padEnd(900, '.'),
        })
      );
    }

    const supabase = makeFakeSupabase({
      agent_identities: [
        {
          id: 'sb-1',
          user_id: USER_ID,
          agent_id: 'aster',
          name: 'Aster',
          role: 'dev',
          values: [],
          capabilities: [],
          relationships: {},
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      users: [{ id: USER_ID, timezone: 'UTC', preferences: {} }],
      contacts: [],
      memories: rows,
      projects: [],
      workspaces: [],
      user_identity: [],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(
      USER_ID,
      'aster',
      makeSession({ threadKey: 'pr:527' })
    );

    expect(ctx.recentMemories[0].id).toBe('on-thread');
    expect(ctx.knowledgeSummary).toContain('THE-ANSWER-IS-HERE');
  });
});

describe('ContextBuilder.buildContext — workspace scoping', () => {
  it("reads the constitution of the agent's own workspace, not the personal one", async () => {
    // A team-workspace agent must not be handed the personal workspace's docs.
    const supabase = makeFakeSupabase({
      agent_identities: [
        {
          id: 'sb-team',
          user_id: USER_ID,
          agent_id: 'aster',
          name: 'Aster',
          role: 'dev',
          values: [],
          capabilities: [],
          relationships: {},
          workspace_id: 'ws-team',
          updated_at: '2026-08-01T00:00:00Z',
        },
      ],
      users: [{ id: USER_ID, timezone: 'UTC', preferences: {} }],
      contacts: [],
      memories: [],
      projects: [],
      workspaces: [
        {
          id: 'ws-personal',
          user_id: USER_ID,
          type: 'personal',
          archived_at: null,
          shared_values: 'PERSONAL-VALUES',
          process: 'PERSONAL-PROCESS',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'ws-team',
          user_id: USER_ID,
          type: 'team',
          archived_at: null,
          shared_values: 'TEAM-VALUES',
          process: 'TEAM-PROCESS',
          created_at: '2026-02-01T00:00:00Z',
        },
      ],
      user_identity: [
        {
          user_id: USER_ID,
          workspace_id: 'ws-personal',
          user_profile_md: 'PERSONAL-USER-DOC',
          shared_values_md: null,
          process_md: null,
          updated_at: '2026-08-01T00:00:00Z',
        },
        {
          user_id: USER_ID,
          workspace_id: 'ws-team',
          user_profile_md: 'TEAM-USER-DOC',
          shared_values_md: null,
          process_md: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const ctx = await new ContextBuilder(supabase).buildContext(USER_ID, 'aster', makeSession());

    expect(ctx.constitution?.values).toBe('TEAM-VALUES');
    expect(ctx.constitution?.process).toBe('TEAM-PROCESS');
    // The personal row was updated more recently — an unscoped query picks it.
    expect(ctx.constitution?.user).toBe('TEAM-USER-DOC');
  });
});

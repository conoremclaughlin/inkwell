/**
 * instantiate_graph_template — the handler against a real DB.
 *
 * The unit tests cover what a constructor emits; these cover what the
 * handler DOES with it, which is where the pr:555 review found two of its
 * five blockers. Both are about ordering and state that only exist once a
 * real group, a real conversion and a real sweep predicate are involved, so
 * a mocked composer would have reproduced neither.
 *
 * Requires .env.local with SUPABASE_URL + SUPABASE_SECRET_KEY.
 * Skipped automatically when credentials are unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { INTEGRATION_TEST_USER_ID } from '../../test/integration-fixtures';
import type { Database } from '../../data/supabase/types';
import { DataComposer } from '../../data/composer';
import { handleInstantiateGraphTemplate, handleListGraphTemplates } from './task-graph-handlers';

const projectRoot = resolve(__dirname, '../../../../../');
const envLocalPath = resolve(projectRoot, '.env.local');
if (existsSync(envLocalPath)) {
  const parsed = dotenv.parse(readFileSync(envLocalPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
const d = SUPABASE_URL && SUPABASE_KEY ? describe : describe.skip;
const USER = INTEGRATION_TEST_USER_ID;

/** Every group this suite creates is titled with this, so cleanup is exact. */
const MARK = 'itest-instantiate';

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

d('instantiate_graph_template (real DB)', () => {
  let client: SupabaseClient<Database>;
  let dataComposer: DataComposer;
  let reviewer: string;

  beforeAll(async () => {
    client = createClient<Database>(SUPABASE_URL!, SUPABASE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    dataComposer = await DataComposer.initialize();
    const { data } = await client.from('agent_identities').select('id').limit(1).maybeSingle();
    if (!data?.id) throw new Error('fixture: no agent identity for gate assignee');
    reviewer = data.id;
  });

  afterAll(async () => {
    const { data } = await client
      .from('task_groups')
      .select('id')
      .eq('user_id', USER)
      .like('title', `${MARK}%`);
    for (const row of data ?? []) {
      await client.from('tasks').delete().eq('task_group_id', row.id);
      await client.from('task_groups').delete().eq('id', row.id);
    }
  });

  const groupCount = async () => {
    const { count } = await client
      .from('task_groups')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', USER)
      .like('title', `${MARK}%`);
    return count ?? 0;
  };

  it('builds the whole pr-ship shape in one call', async () => {
    const built = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} happy path`,
          subject: 'PR #000',
          reviewerIdentityId: reviewer,
          visualSignoffUserId: USER,
          start: false,
        } as never,
        dataComposer
      )
    );
    expect(built.success).toBe(true);
    expect(built.groupCreated).toBe(true);
    expect((built.nodesAdded as Array<{ slug: string }>).map((n) => n.slug).sort()).toEqual([
      'merge',
      'sibling-review',
      'visual-signoff',
      'work',
    ]);
    expect(built.edgesAdded).toHaveLength(4);
  });

  /**
   * start:false has to mean "nothing will run", not "nothing runs yet".
   * listActiveGraphGroups selects on status='active', so an active group is
   * swept and dispatched on the next tick no matter what the handler skipped.
   */
  it('start:false leaves the group PAUSED, out of the sweep entirely', async () => {
    const built = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} paused`,
          subject: 'PR #001',
          reviewerIdentityId: reviewer,
          includeVisualSignoff: false,
          start: false,
        } as never,
        dataComposer
      )
    );
    expect(built.success).toBe(true);

    const group = await dataComposer.repositories.taskGroups.findById(built.groupId as string);
    expect(group!.status).toBe('paused');

    const swept = await dataComposer.repositories.taskGroups.listActiveGraphGroups();
    expect(swept.map((g) => g.id)).not.toContain(built.groupId);

    // Paused also means the graph write itself did not start any clocks.
    expect(built.started).toBeNull();
  });

  it('start defaults to true and the group is active and sweepable', async () => {
    const built = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} started`,
          subject: 'PR #002',
          reviewerIdentityId: reviewer,
          includeVisualSignoff: false,
        } as never,
        dataComposer
      )
    );
    expect(built.success).toBe(true);
    const group = await dataComposer.repositories.taskGroups.findById(built.groupId as string);
    expect(group!.status).toBe('active');
  });

  /**
   * The refusal has to happen before the group exists. Discovering it inside
   * add_graph_nodes is one transaction too late: the group has already been
   * created and converted, so the caller is left holding an empty graph-mode
   * shell it never asked for.
   */
  it('refuses a gate with no principal WITHOUT leaving a group behind', async () => {
    const before = await groupCount();
    const refused = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} no principal`,
          subject: 'PR #003',
          // reviewerIdentityId deliberately omitted
          includeVisualSignoff: false,
          start: false,
        } as never,
        dataComposer
      )
    );
    expect(refused.success).toBe(false);
    expect(refused.problems).toEqual([
      { slug: 'sibling-review', problem: 'gate-has-no-principal' },
    ]);
    expect(await groupCount()).toBe(before);
  });

  /**
   * I first wrote this expecting a refusal, and it failed: the constructor
   * cannot emit two principals, because visualSignoffUserId short-circuits
   * the identity branch. So the real rule to pin is the PRECEDENCE — a human
   * named alongside an SB wins, and the gate becomes an approval gate they
   * are never asked to claim. The preflight's two-principal branch stays as
   * a guard for hand-built shapes; it is simply not reachable from here.
   */
  it('names both visual principals and the human wins, as an approval gate', async () => {
    const built = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} both principals`,
          subject: 'PR #004',
          reviewerIdentityId: reviewer,
          visualSignoffUserId: USER,
          visualSignoffIdentityId: reviewer,
          start: false,
        } as never,
        dataComposer
      )
    );
    expect(built.success).toBe(true);

    const { data: gate } = await client
      .from('tasks')
      .select('assignee_user_id, assignee_identity_id, verification')
      .eq('task_group_id', built.groupId as string)
      .eq('node_slug', 'visual-signoff')
      .single();
    expect(gate!.assignee_user_id).toBe(USER);
    expect(gate!.assignee_identity_id).toBeNull();
    expect((gate!.verification as { mode: string }).mode).toBe('approval');
  });

  /**
   * Cardinality is not existence. A well-formed UUID naming nobody passed
   * the principal-count check, then failed the FK inside add_graph_nodes —
   * after the group had been created and converted, leaving the caller with
   * a graph-mode shell it never asked for. The group count is the assertion
   * that matters; a refusal alone would not have caught it.
   */
  it('refuses a nonexistent principal WITHOUT leaving a group behind', async () => {
    const before = await groupCount();
    const refused = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} ghost principal`,
          subject: 'PR #007',
          // Well-formed, and nobody's.
          reviewerIdentityId: '00000000-0000-4000-8000-000000000000',
          includeVisualSignoff: false,
          start: false,
        } as never,
        dataComposer
      )
    );
    expect(refused.success).toBe(false);
    expect(refused.problems).toEqual([
      { slug: 'sibling-review', principal: '00000000-0000-4000-8000-000000000000' },
    ]);
    expect(await groupCount()).toBe(before);
  });

  it('refuses a visual principal that is a real identity id but not a real user id', async () => {
    const before = await groupCount();
    const refused = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} wrong principal table`,
          subject: 'PR #008',
          reviewerIdentityId: reviewer,
          // An agent identity UUID passed where a users.id belongs.
          visualSignoffUserId: reviewer,
          start: false,
        } as never,
        dataComposer
      )
    );
    expect(refused.success).toBe(false);
    expect((refused.problems as Array<{ slug: string }>).map((p) => p.slug)).toEqual([
      'visual-signoff',
    ]);
    expect(await groupCount()).toBe(before);
  });

  it('injects a fragment into an existing graph and rewires the downstream node', async () => {
    const built = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'pr-ship',
          title: `${MARK} injection`,
          subject: 'PR #005',
          reviewerIdentityId: reviewer,
          includeVisualSignoff: false,
          start: false,
        } as never,
        dataComposer
      )
    );
    const injected = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'visual-signoff',
          taskGroupId: built.groupId,
          subject: 'PR #005',
          visualSignoffUserId: USER,
          after: 'work',
          before: 'merge',
        } as never,
        dataComposer
      )
    );
    expect(injected.success).toBe(true);
    expect(injected.groupCreated).toBe(false);
    expect(injected.edgesAdded).toHaveLength(2);

    const { data: nodes } = await client
      .from('tasks')
      .select('id, node_slug')
      .eq('task_group_id', built.groupId as string);
    const bySlug = new Map((nodes ?? []).map((n) => [n.node_slug, n.id]));
    const edges = await dataComposer.repositories.taskGroups.getEdges(built.groupId as string);
    const inboundOfMerge = edges
      .filter((e) => e.to_task === bySlug.get('merge'))
      .map((e) => [...bySlug.entries()].find(([, id]) => id === e.from_task)![0])
      .sort();
    expect(inboundOfMerge).toEqual(['sibling-review', 'visual-signoff']);
  });

  it('refuses an injectable fragment with no group to inject it into', async () => {
    const before = await groupCount();
    const refused = parse(
      await handleInstantiateGraphTemplate(
        {
          userId: USER,
          templateId: 'visual-signoff',
          title: `${MARK} orphan fragment`,
          subject: 'PR #006',
          visualSignoffUserId: USER,
        } as never,
        dataComposer
      )
    );
    expect(refused.success).toBe(false);
    expect(String(refused.error)).toContain('fragment');
    expect(await groupCount()).toBe(before);
  });

  it('refuses an unknown template and names what is available', async () => {
    const refused = parse(
      await handleInstantiateGraphTemplate(
        { userId: USER, templateId: 'no-such-template', subject: 'x' } as never,
        dataComposer
      )
    );
    expect(refused.success).toBe(false);
    expect(refused.available).toContain('pr-ship');
  });

  it('lists the registry', async () => {
    const listed = parse(await handleListGraphTemplates());
    expect(listed.success).toBe(true);
    expect((listed.templates as Array<{ id: string }>).map((t) => t.id)).toContain('pr-ship');
  });
});

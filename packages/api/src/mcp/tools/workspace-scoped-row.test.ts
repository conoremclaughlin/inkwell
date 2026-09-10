import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { pickWorkspaceScopedRow, WorkspaceRowAmbiguityError } from './workspace-scoped-row';

type Row = { id: string; workspace_id: string | null };

describe('pickWorkspaceScopedRow', () => {
  it('returns null for no rows, and the row for exactly one', () => {
    expect(pickWorkspaceScopedRow<Row>([], 'x')).toBeNull();
    expect(pickWorkspaceScopedRow<Row>(null, 'x')).toBeNull();
    const only: Row = { id: 'a', workspace_id: null };
    expect(pickWorkspaceScopedRow<Row>([only], 'x')).toBe(only);
    // A bare object (single-row clients / mocks) is treated as one row.
    expect(pickWorkspaceScopedRow<Row>(only, 'x')).toBe(only);
  });

  it('prefers the workspace-scoped row over an unscoped twin (the Sep 10 shape)', () => {
    const twin: Row = { id: 'twin', workspace_id: null };
    const real: Row = { id: 'real', workspace_id: 'ws-1' };
    expect(pickWorkspaceScopedRow<Row>([twin, real], 'agent "myra"')).toBe(real);
    expect(pickWorkspaceScopedRow<Row>([real, twin], 'agent "myra"')).toBe(real);
  });

  it('throws a named ambiguity error for two scoped rows — never "not found"', () => {
    const a: Row = { id: 'a', workspace_id: 'ws-1' };
    const b: Row = { id: 'b', workspace_id: 'ws-2' };
    let caught: unknown;
    try {
      pickWorkspaceScopedRow<Row>([a, b], 'agent "wren"');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceRowAmbiguityError);
    const e = caught as WorkspaceRowAmbiguityError;
    expect(e.rowCount).toBe(2);
    expect(e.message).toContain('Multiple rows found for agent "wren" (2)');
    expect(e.message).toContain('workspaceId');
    expect(e.message).not.toContain('No identity found');
  });

  it('two unscoped rows is also an ambiguity (the partial index should prevent it, but never guess)', () => {
    const a: Row = { id: 'a', workspace_id: null };
    const b: Row = { id: 'b', workspace_id: null };
    expect(() => pickWorkspaceScopedRow<Row>([a, b], 'x')).toThrow(WorkspaceRowAmbiguityError);
  });
});

/**
 * record_gate_verdict — the binding the evidence decides reaches SQL.
 *
 * Lumen's PR #678 probe: the RPC had a p_binding_hash and the repository
 * forwarded it, but the MCP schema dropped the field and the handler never
 * passed it, so SQL always received NULL and `binding-mismatch` was
 * unreachable from a tool call. Two assertions, one per seam.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleRecordGateVerdict, recordGateVerdictSchema } from './task-graph-handlers';

vi.mock('../../services/user-resolver', () => ({
  resolveUser: vi.fn(async () => ({ user: { id: '550e8400-e29b-41d4-a716-446655440000' } })),
}));
vi.mock('../../utils/request-context', () => ({
  getRequestContext: () => ({ sbId: '550e8400-e29b-41d4-a716-446655440001' }),
  getSessionContext: () => undefined,
}));
vi.mock('../../services/graph-executor.service', () => ({ GraphExecutorService: vi.fn() }));

const input = {
  taskId: '550e8400-e29b-41d4-a716-446655440002',
  verdict: 'passed' as const,
  expectedAttempt: 2,
  expectedGateVersion: 6,
  bindingHash: 'candidate-A',
  evidence: { checked: true },
};

describe('record_gate_verdict: the verdict binding reaches SQL (Lumen, PR #678)', () => {
  it('the MCP schema preserves the candidate the evidence actually decides', () => {
    expect(recordGateVerdictSchema.parse(input)).toHaveProperty('bindingHash', 'candidate-A');
  });

  it('the handler forwards that candidate rather than disabling binding-mismatch', async () => {
    const recordGateVerdict = vi.fn(async () => ({ success: false, reason: 'binding-mismatch' }));
    await handleRecordGateVerdict(input, {
      repositories: { taskGroups: { recordGateVerdict } },
    } as never);
    expect(recordGateVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ bindingHash: 'candidate-A' })
    );
  });
});

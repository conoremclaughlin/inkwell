import { describe, expect, it, vi } from 'vitest';
import { SessionContextState, CONTEXT_MUTATING_TOOL_NAMES } from './session-context-state.js';
import type { SessionPromptState } from './session-prompt.js';

function fixture() {
  const runtime: SessionPromptState & { detectedModel?: string } = {
    backend: 'claude',
    model: 'model-a',
    maxContextTokens: 10000,
    toolMode: 'backend',
    toolRouting: 'local',
    strictTools: false,
    activeSkills: [],
  };
  const events: Record<string, unknown>[] = [];
  const append = vi.fn((event: Record<string, unknown>) => events.push(event));
  const rolled = vi.fn();
  const state = new SessionContextState({ runtime: () => runtime, append, rolled });
  return { state, runtime, events, append, rolled };
}
const sample = {
  backend: 'claude',
  source: 'json' as const,
  contextTokens: 900,
  inputTokens: 90000, // invoiced aggregate is NOT the final request's context
  contextParts: { inputTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 100 },
};

describe('SessionContextState', () => {
  it('persists only scoped final-request parts, and skips absent usage', () => {
    const f = fixture();
    f.state.provider.id = 'native-a';
    f.state.sampleUsage(sample);
    expect(f.events[0]).toMatchObject({
      type: 'provider_sample',
      backendSessionId: 'native-a',
      model: 'model-a',
      contextTokens: 900,
      inputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
    });
    expect(f.state.measurement()).toMatchObject({
      contextTokens: 900,
      inputTokens: 100,
      cacheReadTokens: 700,
    });
    f.state.sampleUsage(undefined);
    expect(f.events).toHaveLength(1);
  });
  it('records an unknown report as a tombstone instead of retaining a stale measurement', () => {
    const f = fixture();
    f.state.sampleUsage(sample);
    f.state.sampleUsage({ backend: 'claude', source: 'json', inputTokens: 100 });
    expect(f.events[1]).toMatchObject({ type: 'provider_sample', unknown: true });
    expect(f.events[1]).not.toHaveProperty('contextTokens');
    expect(f.state.measurement()).toBeUndefined();
  });
  it.each(['model', 'provider', 'envelope'] as const)(
    'rejects a sample after %s scope drift',
    (part) => {
      const f = fixture();
      f.state.provider.id = 'native-a';
      f.state.sampleUsage(sample);
      if (part === 'model') f.runtime.detectedModel = 'reported-b';
      else if (part === 'provider') f.state.provider.id = 'native-b';
      else
        f.runtime.activeSkills = [
          { name: 'review', source: 'test', content: 'review instructions' },
        ];
      expect(f.state.measurement()).toBeUndefined();
    }
  );
  it('rolls only its own provider and keeps the persisted invalidation before the notice', () => {
    const a = fixture();
    const b = fixture();
    a.state.provider.id = 'a';
    a.state.provider.shape = 'shape';
    a.state.sampleUsage(sample);
    b.state.provider.id = 'b';
    b.state.sampleUsage(sample);
    a.state.roll('over-budget', 'the window grew');
    expect(a.events.at(-1)).toEqual({
      type: 'backend_session_invalidated',
      id: 'a',
      reason: 'over-budget',
    });
    expect(a.state.provider).toEqual({ id: undefined, shape: undefined });
    expect(a.state.measurement()).toBeUndefined();
    expect(a.rolled).toHaveBeenCalledWith('the window grew');
    expect(b.state.measurement()?.contextTokens).toBe(900);
    expect(b.state.provider.id).toBe('b');
  });
  it('does not clear an old session when its invalidation marker is refused', () => {
    const f = fixture();
    f.state.provider.id = 'a';
    f.state.sampleUsage(sample);
    f.append.mockImplementation(() => {
      throw new Error('log closed');
    });
    expect(() => f.state.roll('test', 'test')).toThrow('log closed');
    expect(f.state.provider.id).toBe('a');
    expect(f.state.measurement()?.contextTokens).toBe(900);
    expect(f.rolled).not.toHaveBeenCalled();
  });
  it('clears stateless measurements without inventing a native session marker', () => {
    const f = fixture();
    f.runtime.backend = 'codex';
    f.state.sampleUsage({ ...sample, backend: 'codex' });
    f.state.roll('test', 'test');
    expect(f.events).toHaveLength(1);
    expect(f.state.measurement()).toBeUndefined();
  });
  it.each(CONTEXT_MUTATING_TOOL_NAMES)(
    'advances before and after %s even on error/Stop; settlement is idempotent',
    (tool) => {
      const f = fixture();
      const done = f.state.beginMutation([{ tool: `mcp__inkwell__${tool}` }]);
      expect(f.state.generation).toBe(1);
      expect(f.state.mutationsInFlight).toBe(1);
      done();
      done();
      expect(f.state.generation).toBe(2);
      expect(f.state.mutationsInFlight).toBe(0);
    }
  );
  it('tracks overlapping parent/clone batches but isolates another session', () => {
    const a = fixture();
    const b = fixture();
    const doneParent = a.state.beginMutation([{ tool: 'write' }, { tool: 'edit' }]);
    const doneClone = a.state.beginMutation([{ tool: 'bash' }]);
    expect(a.state.mutationsInFlight).toBe(2);
    doneParent();
    expect(a.state.mutationsInFlight).toBe(1);
    expect(a.state.generation).toBe(3);
    doneClone();
    expect(a.state.generation).toBe(4);
    expect(b.state.generation).toBe(0);
    expect(b.state.mutationsInFlight).toBe(0);
  });
  it('does not dirty discovery for a read-only batch', () => {
    const f = fixture();
    f.state.beginMutation([{ tool: 'read' }, { tool: 'get_artifact' }])();
    expect(f.state.generation).toBe(0);
    expect(f.state.mutationsInFlight).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  applyBackendSelection,
  applyModelSelection,
  type SessionModelState,
} from './session-model.js';
import { contextBudgetForWindow, resolveModelContextWindow } from '../runtime/context-limits.js';
import { promptTransportFor } from './registry.js';

describe('existing session model/backend controls', () => {
  function state(): SessionModelState {
    return {
      backend: 'claude',
      detectedModel: 'old-detection',
      backendTokenWindow: 100,
      maxContextTokens: 80,
      log: { append: vi.fn(() => 1) },
    };
  }
  it.each([true, false])(
    'preserves backend override/window and auto-budget=%s semantics',
    (auto) => {
      const one = state(),
        other = state();
      one.model = 'gpt-5.4';
      applyBackendSelection(one, 'codex', auto);
      const window = resolveModelContextWindow('codex', 'gpt-5.4');
      expect(one).toMatchObject({
        backend: 'codex',
        model: 'gpt-5.4',
        detectedModel: undefined,
        backendTokenWindow: window,
        maxContextTokens: auto ? contextBudgetForWindow(window, promptTransportFor('codex')) : 80,
      });
      expect(one.log.append).not.toHaveBeenCalled();
      expect(other.backend).toBe('claude');
      expect(other.detectedModel).toBe('old-detection');
    }
  );
  it('keeps model-reset/budget markers and clears overrides without changing another state', () => {
    const one = state(),
      other = state();
    applyModelSelection(one, 'sonnet', true);
    expect(one.log.append).toHaveBeenCalledWith({
      type: 'model_detection_reset',
      backend: 'claude',
    });
    expect(one.log.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'context_budget_changed', from: 80 })
    );
    applyModelSelection(one, undefined, false);
    expect(one.model).toBeUndefined();
    expect(one.detectedModel).toBeUndefined();
    expect(other.log.append).not.toHaveBeenCalled();
  });
});

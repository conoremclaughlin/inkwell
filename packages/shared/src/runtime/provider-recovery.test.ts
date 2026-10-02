import { describe, expect, it } from 'vitest';
import {
  findLastBackendSessionInEvents,
  findLastDetectedModelInEvents,
} from './provider-recovery.js';
import { ContextLedger } from './context-ledger.js';
import { hydrateLedgerFromEvents } from './session-history.js';

describe('provider recovery from a host-loaded snapshot', () => {
  it.each([
    'compaction',
    'context_evict',
    'context_trim',
    'context_budget_changed',
    'backend_session_invalidated',
  ])('%s invalidates both the old native session and its context measurement', (type) => {
    const events = [
      { type: 'backend_session', id: 'old', routing: 'local' },
      { type: 'provider_sample', backend: 'claude', at: 'fixture-time', contextTokens: 42 },
      { type },
    ];
    expect(findLastBackendSessionInEvents(events)).toBeUndefined();
    expect(hydrateLedgerFromEvents(new ContextLedger(), events).providerSample).toBeUndefined();
    expect(
      findLastBackendSessionInEvents([
        ...events,
        { type: 'backend_session', id: 'new', routing: 'local' },
      ])
    ).toEqual({ id: 'new', routing: 'local' });
  });

  it('preserves known routing but never invents routing for a legacy or malformed marker', () => {
    for (const routing of [undefined, 'unknown', false]) {
      expect(
        findLastBackendSessionInEvents([{ type: 'backend_session', id: 'fixture', routing }])
      ).toEqual({ id: 'fixture' });
    }
    expect(
      findLastBackendSessionInEvents([
        { type: 'backend_session', id: 'fixture', routing: 'backend' },
      ])
    ).toEqual({ id: 'fixture', routing: 'backend' });
    expect(findLastBackendSessionInEvents([])).toBeUndefined();
  });

  it('isolates detected-model authority by provider and honors a reset before another detection', () => {
    const events = [
      { type: 'model_detected', backend: 'claude', model: 'fixture-large-window' },
      { type: 'model_detected', backend: 'codex', model: 'fixture-other-model' },
      { type: 'model_detection_reset', backend: 'claude' },
    ];
    expect(findLastDetectedModelInEvents(events, 'claude')).toBeUndefined();
    expect(findLastDetectedModelInEvents(events, 'codex')).toBe('fixture-other-model');
    expect(
      findLastDetectedModelInEvents(
        [...events, { type: 'model_detected', backend: 'claude', model: 'fixture-new-model' }],
        'claude'
      )
    ).toBe('fixture-new-model');
  });
});

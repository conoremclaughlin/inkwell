import { describe, it, expect } from 'vitest';
import { automatedTurnMode } from './automated-turns';

describe('automatedTurnMode (INK_AUTOMATED_TURNS)', () => {
  it('unset or blank is standard, the behaviour before the setting', () => {
    expect(automatedTurnMode({})).toEqual({ mode: 'standard', from: 'default' });
    expect(automatedTurnMode({ INK_AUTOMATED_TURNS: '  ' })).toEqual({
      mode: 'standard',
      from: 'default',
    });
  });

  it('yolo and standard are read, case and surrounding space ignored', () => {
    expect(automatedTurnMode({ INK_AUTOMATED_TURNS: ' YOLO ' })).toEqual({
      mode: 'yolo',
      from: 'deployment',
    });
    expect(automatedTurnMode({ INK_AUTOMATED_TURNS: 'standard' }).mode).toBe('standard');
  });

  it('anything else runs standard, and the problem names the variable, not its value', () => {
    const decision = automatedTurnMode({ INK_AUTOMATED_TURNS: 'true' });
    expect(decision.mode).toBe('standard');
    expect(decision.from).toBe('malformed');
    expect(decision.problem).toContain('INK_AUTOMATED_TURNS');
    expect(decision.problem).not.toContain('true');
  });
});

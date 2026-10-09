import { describe, it, expect } from 'vitest';
import { parseSessionControl, readSessionControl } from './session-control.js';
describe('session control vocabulary', () => {
  it.each([
    null,
    {},
    { controlId: 'x', action: 'backend', model: 'codex' },
    { controlId: 'x', action: 'model', model: '' },
    { controlId: 'x', action: 'model', model: 'a\nb' },
    { controlId: 'x', action: 'skill_clear', grant: true },
    { controlId: 'x', action: 'skill_use', name: 'x'.repeat(257) },
  ])('rejects malformed/policy controls %j', (value) =>
    expect(parseSessionControl(value)).toBeUndefined()
  );
  it('accepts only the bounded literal commands and pins their values', () => {
    const input = { controlId: 'x', action: 'model', model: 'selected' };
    const parsed = parseSessionControl(input);
    input.model = 'mutated';
    expect(parsed).toMatchObject({ model: 'selected' });
    expect(parseSessionControl({ controlId: 'x', action: 'model', model: null })).toBeDefined();
  });
  it('refuses instruction-bearing or unbounded persisted state', () => {
    const value = {
      type: 'session_control',
      version: 1,
      controlId: 'x',
      backend: 'claude',
      selection: { skills: [{ name: 'x', content: 'not permitted' }] },
    };
    expect(() => readSessionControl(value)).toThrow();
    expect(() =>
      readSessionControl({ ...value, selection: { skills: Array(17).fill({}) } })
    ).toThrow();
  });
});

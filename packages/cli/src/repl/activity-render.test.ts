import { describe, it, expect } from 'vitest';
import { classifyActivity } from './activity-render.js';

describe('classifyActivity', () => {
  it('renders inbound platform messages as user-style message blocks', () => {
    const plan = classifyActivity(
      { type: 'message_in', agentId: 'myra', platform: 'telegram' },
      'myra'
    );
    expect(plan.mode).toBe('message-in');
    expect(plan.role).toBe('user');
    expect(plan.label).toBe('📨 telegram → myra');
  });

  it('renders outbound platform messages as the agent speaking', () => {
    const plan = classifyActivity(
      { type: 'message_out', agentId: 'myra', platform: 'telegram' },
      'myra'
    );
    expect(plan.mode).toBe('message-out');
    expect(plan.role).toBe('assistant');
    expect(plan.label).toBe('📤 myra → telegram');
  });

  it('falls back to a generic channel label when platform is missing', () => {
    const plan = classifyActivity({ type: 'message_in', agentId: 'myra' }, 'myra');
    expect(plan.label).toBe('📨 channel → myra');
  });

  it('classifies own backend turn lifecycle as bookkeeping (regression: rendered as ⚡ blocks)', () => {
    expect(
      classifyActivity(
        { type: 'agent_spawn', subtype: 'backend_cli:claude-code', agentId: 'myra' },
        'myra'
      ).mode
    ).toBe('bookkeeping');
    expect(
      classifyActivity(
        { type: 'agent_complete', subtype: 'backend_cli:claude-code', agentId: 'myra' },
        'myra'
      ).mode
    ).toBe('bookkeeping');
  });

  it('classifies own tool/state activity as bookkeeping', () => {
    expect(classifyActivity({ type: 'tool_call', agentId: 'myra' }, 'myra').mode).toBe(
      'bookkeeping'
    );
    expect(classifyActivity({ type: 'state_change', agentId: 'myra' }, 'myra').mode).toBe(
      'bookkeeping'
    );
  });

  it('keeps other agents lifecycle as full blocks (not silently dimmed)', () => {
    expect(classifyActivity({ type: 'agent_spawn', agentId: 'wren' }, 'myra').mode).toBe('block');
  });

  it('keeps errors and unknown types as blocks', () => {
    expect(classifyActivity({ type: 'error', agentId: 'myra' }, 'myra').mode).toBe('block');
    expect(classifyActivity({}, 'myra').mode).toBe('block');
  });
});

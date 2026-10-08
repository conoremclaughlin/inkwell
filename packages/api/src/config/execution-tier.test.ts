import { describe, expect, it } from 'vitest';
import { executionTierFor, executionTierPrompt } from './execution-tier';

const SB = '0a1b2c3d-0000-4000-8000-0000000000aa';
const OTHER_SB = '0b1b2c3d-0000-4000-8000-0000000000bb';
const inkling = { sbId: SB, client: 'inkling-mobile' };
const ordinary = { sbId: OTHER_SB, client: null };

describe('executionTierFor', () => {
  it('with nothing set, runs the app client tools-only and everything else full', () => {
    expect(executionTierFor(inkling, {})).toEqual({ tier: 'tools', from: 'client' });
    expect(executionTierFor(ordinary, {})).toEqual({ tier: 'full', from: 'default' });
    expect(executionTierFor({ sbId: null, client: null }, {})).toEqual({
      tier: 'full',
      from: 'default',
    });
  });

  it('takes the deployment default for any SB no narrower setting names', () => {
    expect(executionTierFor(ordinary, { INK_EXECUTION_TIER: 'tools' })).toEqual({
      tier: 'tools',
      from: 'deployment',
    });
    // The client default still decides the client it names.
    expect(executionTierFor(inkling, { INK_EXECUTION_TIER: 'full' })).toEqual({
      tier: 'tools',
      from: 'client',
    });
  });

  it('lets a client map replace the default whole', () => {
    const source = { INK_EXECUTION_TIER_CLIENTS: 'telegram-bridge=tools' };
    expect(executionTierFor(inkling, source)).toEqual({ tier: 'full', from: 'default' });
    expect(executionTierFor({ sbId: OTHER_SB, client: 'Telegram-Bridge' }, source)).toEqual({
      tier: 'tools',
      from: 'client',
    });
  });

  it('puts an SB named by id ahead of its client and the deployment', () => {
    const source = {
      INK_EXECUTION_TIER_SBS: `${SB.toUpperCase()}=full`,
      INK_EXECUTION_TIER: 'tools',
    };
    expect(executionTierFor(inkling, source)).toEqual({ tier: 'full', from: 'sb' });
    expect(executionTierFor(ordinary, source)).toEqual({ tier: 'tools', from: 'deployment' });
  });

  it('fails closed to tools on anything it cannot read, naming the variable and never its value', () => {
    for (const [name, value] of [
      ['INK_EXECUTION_TIER', 'everything'],
      // The sandbox tier isn't accepted yet.
      ['INK_EXECUTION_TIER', 'sandbox'],
      ['INK_EXECUTION_TIER_SBS', 'not-a-uuid=full'],
      ['INK_EXECUTION_TIER_SBS', `${SB}=full,${SB}=tools`],
      ['INK_EXECUTION_TIER_SBS', `${SB}`],
      ['INK_EXECUTION_TIER_CLIENTS', 'inkling-mobile=root'],
      ['INK_EXECUTION_TIER_CLIENTS', '=full'],
    ] as const) {
      const decision = executionTierFor(ordinary, { [name]: value });
      expect(decision, `${name}=${value}`).toEqual({
        tier: 'tools',
        from: 'malformed',
        problem: name,
      });
      expect(JSON.stringify(decision)).not.toContain(value);
    }
  });

  it('treats a blank setting as unset', () => {
    expect(
      executionTierFor(inkling, {
        INK_EXECUTION_TIER_SBS: ' ',
        INK_EXECUTION_TIER_CLIENTS: '',
        INK_EXECUTION_TIER: '  ',
      })
    ).toEqual({ tier: 'tools', from: 'client' });
  });
});

describe('executionTierPrompt', () => {
  it('tells a tools-tier turn its bounds, and adds nothing on full', () => {
    expect(executionTierPrompt('tools')).toContain('### Your environment');
    expect(executionTierPrompt('tools')).toContain('send_to_inbox');
    expect(executionTierPrompt('full')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { CODEX_LAUNCH_REFUSALS, classifyCodexPassthrough } from './codex-launch-config.js';

describe('classifyCodexPassthrough', () => {
  it('carries every --config spelling into `-c V` pairs, in order', () => {
    expect(
      classifyCodexPassthrough(['-c', 'a=1', '--config', 'b=2', '--config=c=3', '-cd=4', '-c=e=5'])
    ).toEqual({ args: ['-c', 'a=1', '-c', 'b=2', '-c', 'c=3', '-c', 'd=4', '-c', 'e=5'] });
  });

  // Codex reads `-c=K=V` as `K=V` (Lumen, measured on 0.159.2): one `=` after
  // a short option is a separator. A separate value is taken as it is.
  it('drops exactly one = after a short option, and none from a separate value', () => {
    expect(classifyCodexPassthrough(['-c==x=1', '-c', '=y=2', '-m=gpt-synthetic'])).toEqual({
      args: ['-c', '=x=1', '-c', '=y=2'],
    });
  });

  it('passes over options that do not touch the config, with their values', () => {
    expect(
      classifyCodexPassthrough([
        '--color',
        'never',
        '--sandbox=read-only',
        '-m',
        'gpt-synthetic',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'a=1',
      ])
    ).toEqual({ args: ['-c', 'a=1'] });
  });

  it('reads a value that looks like an option as the value it is', () => {
    expect(classifyCodexPassthrough(['--model', '-c', '-c', 'a=1'])).toEqual({
      args: ['-c', 'a=1'],
    });
  });

  it('treats a bare dash and everything after `--` as positional', () => {
    expect(classifyCodexPassthrough(['-', '--', '-p', 'work', '--whatever'])).toEqual({
      args: [],
    });
  });

  it('refuses a profile, a working directory and a feature switch in every spelling', () => {
    for (const [passthrough, reason] of [
      [['-p', 'work'], CODEX_LAUNCH_REFUSALS.profile],
      [['-pwork'], CODEX_LAUNCH_REFUSALS.profile],
      [['--profile', 'work'], CODEX_LAUNCH_REFUSALS.profile],
      [['--profile=work'], CODEX_LAUNCH_REFUSALS.profile],
      [['-C', '/synthetic/dir'], CODEX_LAUNCH_REFUSALS.directory],
      [['--cd=/synthetic/dir'], CODEX_LAUNCH_REFUSALS.directory],
      [['--enable', 'apps'], CODEX_LAUNCH_REFUSALS.feature],
      [['--disable=apps'], CODEX_LAUNCH_REFUSALS.feature],
    ] as const) {
      expect(classifyCodexPassthrough(passthrough), passthrough.join(' ')).toEqual({
        refusal: reason,
      });
    }
  });

  it('refuses an unknown option, a value given to a flag, and an option with no value', () => {
    expect(classifyCodexPassthrough(['--api-key=synthetic-secret'])).toEqual({
      refusal: CODEX_LAUNCH_REFUSALS.unclassified,
    });
    expect(classifyCodexPassthrough(['--json=1'])).toEqual({
      refusal: CODEX_LAUNCH_REFUSALS.unclassified,
    });
    expect(classifyCodexPassthrough(['-c'])).toEqual({
      refusal: CODEX_LAUNCH_REFUSALS.missingValue,
    });
  });
});

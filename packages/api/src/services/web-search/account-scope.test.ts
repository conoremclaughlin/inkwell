import { describe, expect, it } from 'vitest';
import { isWebSearchAccountAllowed } from './config';

const account = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';

describe('operator-named subscription account scope', () => {
  it.each([
    undefined,
    '',
    ' ',
    '*',
    other,
    account + ',',
    ',' + account,
    account + ',typo',
    Array(33).fill(account).join(','),
    'x'.repeat(4097),
  ])('fails closed for %s', (raw) => {
    expect(isWebSearchAccountAllowed(account, { INK_WEB_SEARCH_ACCOUNT_IDS: raw })).toBe(false);
  });
  it('accepts only exact UUIDs and normalizes list whitespace/case', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const env = { INK_WEB_SEARCH_ACCOUNT_IDS: ` ${id.toUpperCase()}, ${account} ` };
    expect(isWebSearchAccountAllowed(id, env)).toBe(true);
    expect(isWebSearchAccountAllowed(account, env)).toBe(true);
    expect(isWebSearchAccountAllowed(other, env)).toBe(false);
    expect(isWebSearchAccountAllowed(account.slice(0, -1), env)).toBe(false);
  });
});

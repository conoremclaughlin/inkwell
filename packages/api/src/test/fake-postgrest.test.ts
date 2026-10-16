import { expect, it } from 'vitest';
import { FakePostgrest } from './fake-postgrest';

it('models inclusive lte expiry while excluding null and missing values', async () => {
  const db = new FakePostgrest();
  for (const value of ['2026-01-01', '2026-01-02', '2026-01-03', null, undefined])
    db.seed('synthetic_rows', { expires_at: value });
  const result = await db
    .from('synthetic_rows')
    .select('expires_at')
    .lte('expires_at', '2026-01-02');
  expect(result).toEqual({
    data: [{ expires_at: '2026-01-01' }, { expires_at: '2026-01-02' }],
    error: null,
  });
});

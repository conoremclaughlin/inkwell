import { describe, it, expect } from 'vitest';
import { makeFakeSupabase } from './sessions/fake-supabase';
import {
  ANONYMOUS_PERSON,
  describePeople,
  personDisplayName,
  resolvePersonNames,
} from './person-display';

describe('personDisplayName', () => {
  it('prefers the full name, then the username, then the email, then the anonymous label', () => {
    expect(
      personDisplayName({ first_name: 'Conor', last_name: 'M', username: 'cm', email: 'c@x' })
    ).toBe('Conor M');
    expect(personDisplayName({ first_name: ' Conor ', last_name: null })).toBe('Conor');
    expect(personDisplayName({ first_name: '', username: 'cm', email: 'c@x' })).toBe('cm');
    expect(personDisplayName({ username: '  ', email: 'c@x' })).toBe('c@x');
    expect(personDisplayName({ email: '' })).toBe(ANONYMOUS_PERSON);
    expect(personDisplayName(null)).toBe(ANONYMOUS_PERSON);
  });
});

describe('resolvePersonNames + describePeople', () => {
  const db = makeFakeSupabase({
    users: [
      { id: 'user-a', first_name: 'Conor', last_name: null, username: null, email: 'c@x' },
      { id: 'user-b', first_name: null, last_name: null, username: 'lumen-human', email: null },
    ],
  });

  it('resolves every named person in one batch and labels the viewer as their own', async () => {
    const names = await resolvePersonNames(db, ['user-a', 'user-b', 'user-a', 'user-gone']);
    expect([...names.entries()]).toEqual([
      ['user-a', 'Conor'],
      ['user-b', 'lumen-human'],
    ]);
    expect(describePeople(['user-a', 'user-b', 'user-gone'], names, 'user-b')).toEqual([
      { userId: 'user-a', name: 'Conor', isOwn: false },
      { userId: 'user-b', name: 'lumen-human', isOwn: true },
      { userId: 'user-gone', name: ANONYMOUS_PERSON, isOwn: false },
    ]);
  });

  it('the same people read differently to a different viewer, and never as own to nobody', async () => {
    const names = await resolvePersonNames(db, ['user-a', 'user-b']);
    expect(describePeople(['user-a', 'user-b'], names, 'user-a').map((p) => p.isOwn)).toEqual([
      true,
      false,
    ]);
    expect(describePeople(['user-a', 'user-b'], names, null).map((p) => p.isOwn)).toEqual([
      false,
      false,
    ]);
  });

  it('no ids means no query', async () => {
    const strict = {
      from: () => {
        throw new Error('should not query');
      },
    };
    expect(await resolvePersonNames(strict, [])).toEqual(new Map());
  });
});

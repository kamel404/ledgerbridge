import { passwordMatches, safeNext, SESSION_SECONDS, signSession, verifySession } from './session';

describe('session cookie', () => {
  const now = Date.UTC(2026, 10, 13, 12);

  it('accepts its own token until it expires', () => {
    const token = signSession('key', now);
    expect(verifySession(token, 'key', now)).toBe(true);
    expect(verifySession(token, 'key', now + (SESSION_SECONDS - 1) * 1000)).toBe(true);
    expect(verifySession(token, 'key', now + SESSION_SECONDS * 1000)).toBe(false);
  });

  it('rejects another key, a changed expiry, and junk', () => {
    const token = signSession('key', now);
    const [exp, sig] = token.split('.');
    expect(verifySession(token, 'other-key', now)).toBe(false);
    expect(verifySession(`${Number(exp) + 9999}.${sig}`, 'key', now)).toBe(false);
    expect(verifySession(undefined, 'key', now)).toBe(false);
    expect(verifySession('', 'key', now)).toBe(false);
    expect(verifySession('abc', 'key', now)).toBe(false);
    expect(verifySession(`${token}.x`, 'key', now)).toBe(false);
  });

  it('compares passwords exactly', () => {
    expect(passwordMatches('s3cret', 's3cret')).toBe(true);
    expect(passwordMatches('s3cret ', 's3cret')).toBe(false);
    expect(passwordMatches('', 's3cret')).toBe(false);
  });

  it('only redirects to paths on this site', () => {
    expect(safeNext('/syncs?status=DEAD')).toBe('/syncs?status=DEAD');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('/login')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

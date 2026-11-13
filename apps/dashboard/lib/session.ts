import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// The login session: a cookie holding its own expiry time plus an HMAC of it,
// made with the session key from Secrets Manager. Nothing is stored on the
// server. Changing the session key logs everyone out.

export const SESSION_COOKIE = 'lb_session';
export const SESSION_SECONDS = 12 * 60 * 60;

const mac = (key: string, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

/** Constant-time string comparison (hashing first makes the lengths equal). */
function same(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function signSession(key: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${exp}.${mac(key, `v1.${exp}`)}`;
}

export function verifySession(token: string | undefined, key: string, now = Date.now()): boolean {
  if (!token) return false;
  const [expText, sig, ...rest] = token.split('.');
  if (!expText || !sig || rest.length > 0 || !/^\d+$/.test(expText)) return false;
  if (!same(sig, mac(key, `v1.${expText}`))) return false;
  return Number(expText) * 1000 > now;
}

export function passwordMatches(given: string, expected: string): boolean {
  return same(given, expected);
}

/** Where to go after login: only a path on this site, never another host. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next === '/login' || next.startsWith('/login?')) return '/';
  return next;
}

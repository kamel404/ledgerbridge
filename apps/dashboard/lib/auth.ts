import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from './session';
import { loadSettings } from './settings';

/** True when login is off, or the request carries a valid session cookie. */
export async function isSignedIn(): Promise<boolean> {
  const { auth } = await loadSettings();
  if (auth.mode === 'off') return true;
  if (auth.mode !== 'password') return false;
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value, auth.sessionKey);
}

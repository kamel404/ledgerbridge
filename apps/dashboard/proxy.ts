import { type NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession } from './lib/session';
import { loadSettings } from './lib/settings';

// Runs before every page and server action: without a valid session cookie,
// send the visitor to /login. The Replay action checks the session again
// itself (lib/auth.ts), so a mistake here can't let anyone replay events.

export async function proxy(req: NextRequest) {
  const { auth } = await loadSettings();
  if (auth.mode === 'off') return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (pathname === '/login') return NextResponse.next();
  if (auth.mode === 'password' && verifySession(req.cookies.get(SESSION_COOKIE)?.value, auth.sessionKey)) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's static files (JS/CSS chunks hold no data).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

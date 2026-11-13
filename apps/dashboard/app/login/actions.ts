'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { passwordMatches, safeNext, SESSION_COOKIE, SESSION_SECONDS, signSession } from '@/lib/session';
import { loadSettings } from '@/lib/settings';

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const { auth } = await loadSettings();
  if (auth.mode === 'off') redirect('/');
  if (auth.mode !== 'password') return { error: 'Login is not set up on this server (no dashboard password found).' };

  const password = form.get('password');
  if (typeof password !== 'string' || !passwordMatches(password, auth.password)) {
    // Slows down password guessing.
    await new Promise((r) => setTimeout(r, 1000));
    return { error: 'Wrong password.' };
  }

  (await cookies()).set(SESSION_COOKIE, signSession(auth.sessionKey), {
    httpOnly: true, // page scripts can't read it
    secure: true, // HTTPS only (browsers treat localhost as secure too)
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  redirect(safeNext(form.get('next')));
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

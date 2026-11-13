'use client';

import { useActionState } from 'react';
import { loginAction, type LoginState } from './actions';

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="card login">
      <input type="hidden" name="next" value={next} />
      <label>
        Password
        <input type="password" name="password" autoComplete="current-password" required autoFocus />
      </label>
      <button type="submit" className="primary" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      {state.error && <p className="notice bad">{state.error}</p>}
    </form>
  );
}

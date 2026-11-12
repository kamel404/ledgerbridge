'use client';

import { useActionState } from 'react';
import { replayAction, type ReplayState } from './actions';

export function ReplayButton({ eventId }: { eventId: string }) {
  const [state, action, pending] = useActionState<ReplayState, FormData>(replayAction.bind(null, eventId), {});
  return (
    <form action={action}>
      <button type="submit" className="primary" disabled={pending || state.ok}>
        {pending ? 'Replaying…' : state.ok ? 'Replayed' : 'Replay'}
      </button>
      {state.message && <p className={`notice ${state.ok ? 'ok' : 'bad'}`}>{state.message}</p>}
    </form>
  );
}

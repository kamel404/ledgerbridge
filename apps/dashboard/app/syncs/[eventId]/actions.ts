'use server';

import { revalidatePath } from 'next/cache';
import { AdminApiError, adminApi } from '@/lib/admin-api';
import { isSignedIn } from '@/lib/auth';
import { syncHref } from '@/lib/format';

export interface ReplayState {
  ok?: boolean;
  message?: string;
}

/**
 * Server action behind the Replay button. Runs on the Next.js server, so the
 * admin key never reaches the browser. (Next.js also checks that the request
 * comes from this site's own pages before running an action.)
 */
export async function replayAction(eventId: string, _prev: ReplayState, _form: FormData): Promise<ReplayState> {
  // Checked here as well as in proxy.ts: this is the one action that changes data.
  if (!(await isSignedIn())) return { ok: false, message: 'Your session has expired. Sign in again.' };
  try {
    await adminApi.replay(eventId);
  } catch (err) {
    return { ok: false, message: err instanceof AdminApiError ? err.message : 'Replay failed' };
  }
  revalidatePath(syncHref(eventId));
  return { ok: true, message: 'Sent to the queue again. It usually finishes within a few seconds: refresh to see it.' };
}

'use server';

import { revalidatePath } from 'next/cache';
import { AdminApiError, adminApi } from '@/lib/admin-api';
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
  try {
    await adminApi.replay(eventId);
  } catch (err) {
    return { ok: false, message: err instanceof AdminApiError ? err.message : 'Replay failed' };
  }
  revalidatePath(syncHref(eventId));
  return { ok: true, message: 'Sent to the queue again. It usually finishes within a few seconds: refresh to see it.' };
}

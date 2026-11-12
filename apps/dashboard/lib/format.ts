import { FLOWS, SYNC_STATUSES, type Flow, type SyncFilters, type SyncStatus } from './types';

/** "3 min ago", "2 h ago", "5 d ago" (or "just now"). */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** 2026-11-12 14:03:07 UTC */
export function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** How each status is shown: a colour group and a plain-words meaning. */
export const STATUS_INFO: Record<SyncStatus, { tone: 'ok' | 'busy' | 'warn' | 'bad' | 'muted'; meaning: string }> = {
  RECEIVED: { tone: 'busy', meaning: 'Accepted, waiting in the queue' },
  PROCESSING: { tone: 'busy', meaning: 'Being sent to the ERP right now' },
  SUCCEEDED: { tone: 'ok', meaning: 'In the ERP' },
  RETRYING: { tone: 'warn', meaning: 'Failed for a temporary reason; will be tried again' },
  FAILED: { tone: 'bad', meaning: 'Failed for good: the data or a mapping needs fixing, then Replay' },
  DEAD: { tone: 'bad', meaning: 'Failed 4 times in a row (e.g. ERP down); Replay once the cause is fixed' },
  REJECTED: { tone: 'muted', meaning: 'Refused at the door: not a valid event' },
};

export const REPLAYABLE: readonly SyncStatus[] = ['FAILED', 'DEAD'];

/** Reads the Syncs page's ?status=&flow=&q=&cursor=, ignoring anything invalid. */
export function parseFilters(params: Record<string, string | string[] | undefined>): SyncFilters {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const status = one('status');
  const flow = one('flow');
  const q = one('q');
  const cursor = one('cursor');
  return {
    ...(status && (SYNC_STATUSES as readonly string[]).includes(status) && { status: status as SyncStatus }),
    ...(flow && (FLOWS as readonly string[]).includes(flow) && { flow: flow as Flow }),
    ...(q && { q: q.slice(0, 100) }),
    ...(cursor && { cursor }),
  };
}

/** Path to one sync's page. Event IDs can contain ':' (CSV imports), hence the encoding. */
export function syncHref(eventId: string): string {
  return `/syncs/${encodeURIComponent(eventId)}`;
}

/** Route params may arrive still URL-encoded; decode once, safely. */
export function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

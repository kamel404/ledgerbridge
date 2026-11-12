import { Flow, SyncStatus } from '@ledgerbridge/shared';
import type { SyncRecord } from './sync-record.js';

/** What the Syncs page shows per row: the record without payload, history and ttl. */
export type SyncSummary = Omit<SyncRecord, 'payload' | 'history' | 'ttl'>;

export interface ListQuery {
  status?: SyncStatus;
  flow?: Flow;
  /** Search: part of the business key (any case), or an exact event ID. */
  q?: string;
  limit: number;
  /** From the previous page's nextCursor. */
  cursor?: string;
}

export interface ListPage {
  items: SyncSummary[];
  /** Pass back as `cursor` for the next page. Missing on the last page. */
  nextCursor?: string;
}

/** Position in one status's newest-first list: the byStatus index key of the last item read. */
export interface StatusKey {
  eventId: string;
  status: SyncStatus;
  updatedAt: string;
}

/**
 * Reads one status's records, newest first, starting after `startKey`, and
 * returns up to `need` that match the filters.
 *
 * - exhausted: there is nothing more after what was returned
 * - scanPosition: how far it read, for when nothing matched in the reading
 *   budget (so the next page doesn't read the same items again)
 */
export type StatusSource = (
  status: SyncStatus,
  startKey: StatusKey | undefined,
  need: number,
) => Promise<{ items: SyncSummary[]; exhausted: boolean; scanPosition?: StatusKey }>;

export class InvalidCursorError extends Error {}

/** Same filter for every storage: flow, and the search text. */
export function matchesQuery(r: Pick<SyncRecord, 'flow' | 'businessKey' | 'eventId'>, query: Pick<ListQuery, 'flow' | 'q'>) {
  if (query.flow && r.flow !== query.flow) return false;
  if (query.q) {
    const q = query.q.trim();
    if (r.eventId !== q && !(r.businessKey ?? '').toUpperCase().includes(q.toUpperCase())) return false;
  }
  return true;
}

/** Newest first; event ID breaks ties so the order is stable. */
export function newestFirst(a: Pick<SyncRecord, 'updatedAt' | 'eventId'>, b: Pick<SyncRecord, 'updatedAt' | 'eventId'>): number {
  return a.updatedAt === b.updatedAt ? b.eventId.localeCompare(a.eventId) : b.updatedAt.localeCompare(a.updatedAt);
}

export function toSummary(r: SyncRecord | SyncSummary): SyncSummary {
  const { payload: _p, history: _h, ttl: _t, ...summary } = r as SyncRecord;
  return summary;
}

type CursorState = Partial<Record<SyncStatus, StatusKey | 'done'>>;

/**
 * "All syncs, newest first" across statuses without a dedicated index.
 *
 * DynamoDB can list ONE status newest-first (the byStatus index). For several
 * statuses, read the newest `limit` matches of each, merge them, and keep the
 * newest `limit`. The cursor remembers, per status, the last item shown (or
 * "done"), so the next page continues each list exactly where it stopped.
 *
 * The alternative, an index with every record under one key, puts all writes
 * on a single partition: the classic DynamoDB anti-pattern.
 */
export async function listAcrossStatuses(source: StatusSource, query: ListQuery): Promise<ListPage> {
  const statuses = query.status ? [query.status] : SyncStatus.options;
  const state = decodeCursor(query.cursor);

  const fetched = await Promise.all(
    statuses.map(async (status) => {
      const pos = state[status];
      if (pos === 'done') return { status, items: [], exhausted: true, scanPosition: undefined };
      return { status, ...(await source(status, pos, query.limit)) };
    }),
  );

  const page = fetched
    .flatMap((f) => f.items)
    .sort(newestFirst)
    .slice(0, query.limit);

  const next: CursorState = {};
  for (const f of fetched) {
    const shown = page.filter((i) => i.status === f.status);
    const last = shown.at(-1);
    const allShown = shown.length === f.items.length;
    if (allShown && f.exhausted) next[f.status] = 'done';
    else if (last) next[f.status] = { eventId: last.eventId, status: f.status, updatedAt: last.updatedAt };
    else if (f.items.length === 0 && f.scanPosition) next[f.status] = f.scanPosition;
    else if (state[f.status]) next[f.status] = state[f.status];
  }
  const more = statuses.some((s) => next[s] !== 'done');
  return { items: page, ...(more && { nextCursor: encodeCursor(next) }) };
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorState {
  if (!cursor) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('Invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InvalidCursorError('Invalid cursor');
  const state: CursorState = {};
  for (const [status, pos] of Object.entries(parsed)) {
    if (!SyncStatus.safeParse(status).success) throw new InvalidCursorError('Invalid cursor');
    const s = status as SyncStatus;
    if (pos === 'done') state[s] = 'done';
    else if (isStatusKey(pos) && pos.status === s) state[s] = pos;
    else throw new InvalidCursorError('Invalid cursor');
  }
  return state;
}

function isStatusKey(v: unknown): v is StatusKey {
  const k = v as StatusKey;
  return typeof k === 'object' && k !== null && typeof k.eventId === 'string' && typeof k.updatedAt === 'string' && typeof k.status === 'string';
}

/** Counts per status and flow, for the Overview tiles. */
export type StatusCounts = Record<SyncStatus, Record<Flow, number>>;

export function emptyCounts(): StatusCounts {
  return Object.fromEntries(
    SyncStatus.options.map((s) => [s, Object.fromEntries(Flow.options.map((f) => [f, 0]))]),
  ) as StatusCounts;
}

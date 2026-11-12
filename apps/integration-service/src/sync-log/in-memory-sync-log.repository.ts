import type { SyncStatus } from '@ledgerbridge/shared';
import {
  emptyCounts,
  listAcrossStatuses,
  matchesQuery,
  newestFirst,
  toSummary,
  type ListPage,
  type ListQuery,
  type StatusCounts,
} from './sync-list.js';
import type { SyncLogRepository, SyncRecord } from './sync-record.js';

/** Local-only sync log (local dev, tests). Lost on restart. */
export class InMemorySyncLogRepository implements SyncLogRepository {
  private readonly records = new Map<string, SyncRecord>();

  async create(record: SyncRecord): Promise<boolean> {
    if (this.records.has(record.eventId)) return false;
    this.records.set(record.eventId, structuredClone(record));
    return true;
  }

  async get(eventId: string): Promise<SyncRecord | undefined> {
    const record = this.records.get(eventId);
    return record && structuredClone(record);
  }

  async put(record: SyncRecord): Promise<void> {
    this.records.set(record.eventId, structuredClone(stripUndefined(record)));
  }

  async replaceIf(record: SyncRecord, expectedStatus: SyncStatus): Promise<boolean> {
    if (this.records.get(record.eventId)?.status !== expectedStatus) return false;
    await this.put(record);
    return true;
  }

  /** Same paging as DynamoDB: one newest-first list per status, merged. */
  list(query: ListQuery): Promise<ListPage> {
    return listAcrossStatuses(async (status, startKey, need) => {
      const all = [...this.records.values()].filter((r) => r.status === status).sort(newestFirst);
      const start = startKey ? all.findIndex((r) => r.eventId === startKey.eventId) + 1 : 0;
      const rest = all.slice(start).filter((r) => matchesQuery(r, query));
      return { items: rest.slice(0, need).map((r) => toSummary(structuredClone(r))), exhausted: rest.length <= need };
    }, query);
  }

  async countSince(sinceIso: string): Promise<StatusCounts> {
    const counts = emptyCounts();
    for (const r of this.records.values()) if (r.updatedAt >= sinceIso) counts[r.status][r.flow]++;
    return counts;
  }

  /** For tests and debugging. */
  all(): SyncRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
}

/** Like DynamoDB's removeUndefinedValues: `lastError: undefined` removes the field. */
function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

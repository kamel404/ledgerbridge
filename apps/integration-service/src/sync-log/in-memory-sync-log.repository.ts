import type { SyncLogRepository, SyncRecord } from './sync-record.js';

/** Local-only sync log. Lost on restart, which is fine until DynamoDB arrives in Phase 3. */
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
    this.records.set(record.eventId, structuredClone(record));
  }

  /** For tests and debugging. */
  all(): SyncRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
}

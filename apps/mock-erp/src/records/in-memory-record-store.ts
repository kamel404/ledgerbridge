import type { RecordStore, StoredRecord } from './record-store.js';
import type { RecordType } from './record-types.js';

/**
 * Keeps records in memory. Data is lost when the process stops, which is fine
 * for local development and tests. Records are copied in and out so callers
 * can never change stored data by accident.
 */
export class InMemoryRecordStore implements RecordStore {
  private readonly records = new Map<RecordType, Map<string, StoredRecord>>();
  private readonly byExternalId = new Map<RecordType, Map<string, string>>();
  private readonly counters = new Map<RecordType, number>();

  async nextId(type: RecordType): Promise<string> {
    const next = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, next);
    return String(next);
  }

  async get(type: RecordType, id: string): Promise<StoredRecord | undefined> {
    const record = this.table(type).get(id);
    return record && structuredClone(record);
  }

  async getByExternalId(type: RecordType, externalId: string): Promise<StoredRecord | undefined> {
    const id = this.index(type).get(externalId);
    return id === undefined ? undefined : this.get(type, id);
  }

  async list(type: RecordType): Promise<StoredRecord[]> {
    return [...this.table(type).values()]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((r) => structuredClone(r));
  }

  async save(records: StoredRecord[]): Promise<void> {
    for (const record of records) {
      const previous = this.table(record.type).get(record.id);
      if (previous?.externalId && previous.externalId !== record.externalId) {
        this.index(record.type).delete(previous.externalId);
      }
      this.table(record.type).set(record.id, structuredClone(record));
      if (record.externalId) {
        this.index(record.type).set(record.externalId, record.id);
      }
    }
  }

  async delete(type: RecordType, id: string): Promise<boolean> {
    const record = this.table(type).get(id);
    if (!record) return false;
    this.table(type).delete(id);
    if (record.externalId) this.index(type).delete(record.externalId);
    return true;
  }

  private table(type: RecordType): Map<string, StoredRecord> {
    let table = this.records.get(type);
    if (!table) this.records.set(type, (table = new Map()));
    return table;
  }

  private index(type: RecordType): Map<string, string> {
    let index = this.byExternalId.get(type);
    if (!index) this.byExternalId.set(type, (index = new Map()));
    return index;
  }
}

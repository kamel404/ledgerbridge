import type { RecordType } from './record-types.js';

/** One ERP record as stored. */
export interface StoredRecord {
  type: RecordType;
  /** Internal ID, assigned by the ERP: "1", "2", ... */
  id: string;
  /** ID from the source system, unique per record type. */
  externalId?: string;
  /** Fields sent by the client, validated, with references resolved. */
  fields: Record<string, unknown>;
  /** Fields the ERP calculates (invoice total, amountRemaining, ...). */
  computed: Record<string, unknown>;
  createdDate: string;
  lastModifiedDate: string;
  /**
   * Set by the store when it reads a record; undefined for a new record.
   * The DynamoDB store refuses to save if the stored version changed since the
   * read (optimistic locking), so two Lambdas can't overwrite each other's
   * changes. The in-memory store ignores it (one process, WriteLock).
   */
  version?: number;
}

/**
 * Where records live. The business rules (RecordsService) only talk to this
 * interface, so the in-memory store (Phase 1) and the DynamoDB store (Phase 3)
 * are interchangeable.
 */
export interface RecordStore {
  /** Next internal ID for a record type (a per-type counter). */
  nextId(type: RecordType): Promise<string>;
  get(type: RecordType, id: string): Promise<StoredRecord | undefined>;
  getByExternalId(type: RecordType, externalId: string): Promise<StoredRecord | undefined>;
  /** All records of a type, in internal-ID order. Used by SuiteQL. */
  list(type: RecordType): Promise<StoredRecord[]>;
  /**
   * Creates or replaces several records together, e.g. a payment and the
   * invoice it pays. (The DynamoDB store will use a transaction here.)
   */
  save(records: StoredRecord[]): Promise<void>;
  /** Returns false if the record did not exist. */
  delete(type: RecordType, id: string): Promise<boolean>;
}

/** Nest injection token for the RecordStore implementation. */
export const RECORD_STORE = Symbol('RECORD_STORE');

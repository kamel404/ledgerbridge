import type { Flow, Source, SyncStatus } from '@ledgerbridge/shared';
import type { ErrorSummary } from '../errors/integration-errors.js';
import type { ListPage, ListQuery, StatusCounts } from './sync-list.js';

/** One status change, for the dashboard's timeline (PLAN gap 4: the spec has no history). */
export interface SyncHistoryEntry {
  status: SyncStatus;
  at: string;
  /** Error code or short note, e.g. "ERP_SERVICE_UNAVAILABLE". */
  note?: string;
}

/**
 * One event's journey through LedgerBridge (SPEC §8.5). The key is the event
 * ID, which is what makes the ingest dedup and event-level idempotency work.
 */
export interface SyncRecord {
  eventId: string;
  source: Source;
  flow: Flow;
  /** Missing when the body couldn't be parsed at all (REJECTED). */
  eventType?: string;
  status: SyncStatus;
  attempts: number;
  /** e.g. INV-1042, for searching. */
  businessKey?: string;
  erpRecordType?: string;
  erpRecordId?: string;
  lastError?: ErrorSummary;
  /** The original event, kept for replay. For a REJECTED body: whatever was received. */
  payload: unknown;
  receivedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Epoch seconds. DynamoDB deletes the item after this (90 days). */
  ttl: number;
  history: SyncHistoryEntry[];
}

/**
 * Storage for sync records. In-memory locally; DynamoDB from Phase 3 with the
 * same interface, so nothing else changes.
 */
export interface SyncLogRepository {
  /**
   * Stores a new record unless one with the same eventId exists.
   * Returns false for a duplicate (DynamoDB: conditional put on attribute_not_exists).
   */
  create(record: SyncRecord): Promise<boolean>;
  get(eventId: string): Promise<SyncRecord | undefined>;
  /** Replaces a stored record. */
  put(record: SyncRecord): Promise<void>;
  /**
   * Replaces a stored record only if its status is still `expectedStatus`.
   * Returns false if someone changed it first (e.g. two Replay clicks).
   */
  replaceIf(record: SyncRecord, expectedStatus: SyncStatus): Promise<boolean>;
  /** One page of records, newest first (see sync-list.ts). */
  list(query: ListQuery): Promise<ListPage>;
  /** How many records per status and flow were last updated at or after `sinceIso`. */
  countSince(sinceIso: string): Promise<StatusCounts>;
  /** Every record with this status last updated at or after `sinceIso` (for reconciliation). */
  listSince(status: SyncStatus, sinceIso: string): Promise<SyncRef[]>;
}

/** The fields reconciliation needs: which ERP record an event produced. */
export type SyncRef = Pick<SyncRecord, 'eventId' | 'flow' | 'businessKey' | 'erpRecordType' | 'erpRecordId' | 'updatedAt'>;

export const SYNC_LOG_REPOSITORY = Symbol('SYNC_LOG_REPOSITORY');

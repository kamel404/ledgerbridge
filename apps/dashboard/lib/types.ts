// Shapes of the admin API's responses (integration-service, src/admin/).
// Kept here instead of importing the service's code: the HTTP API is the contract.

export const SYNC_STATUSES = ['RECEIVED', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'DEAD', 'REJECTED'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const FLOWS = ['O2C', 'P2P'] as const;
export type Flow = (typeof FLOWS)[number];

export interface ErrorSummary {
  code: string;
  message: string;
  class: 'retryable' | 'permanent';
}

export interface SyncSummary {
  eventId: string;
  source: 'billing' | 'procurement' | 'csv';
  flow: Flow;
  eventType?: string;
  status: SyncStatus;
  attempts: number;
  businessKey?: string;
  erpRecordType?: string;
  erpRecordId?: string;
  lastError?: ErrorSummary;
  receivedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SyncRecord extends SyncSummary {
  payload: unknown;
  history: Array<{ status: SyncStatus; at: string; note?: string }>;
}

export interface SyncPage {
  items: SyncSummary[];
  nextCursor?: string;
}

export interface QueueDepth {
  waiting: number;
  inFlight: number;
}

export interface Stats {
  since: string;
  until: string;
  byStatus: Record<SyncStatus, number>;
  byFlow: Record<Flow, Record<SyncStatus, number>>;
  queues?: { queue: QueueDepth; dlq: QueueDepth };
  /** The last reconciliation run; null before the first one. */
  reconciliation: ReconciliationReport | null;
}

export const RECONCILED_TYPES = ['invoice', 'customerPayment', 'vendorBill'] as const;
export type ReconciledType = (typeof RECONCILED_TYPES)[number];

export interface Mismatch {
  kind: 'MISSING_IN_ERP' | 'MISSING_IN_LEDGERBRIDGE' | 'ERP_ID_CHANGED';
  recordType: ReconciledType;
  externalId: string;
  erpRecordId?: string;
  eventId?: string;
}

export interface ReconciliationReport {
  runAt: string;
  since: string;
  until: string;
  byType: Record<ReconciledType, { synced: number; createdInErp: number; matched: number }>;
  mismatchCount: number;
  /** At most 100; mismatchCount has the full number. */
  mismatches: Mismatch[];
}

export interface SyncFilters {
  status?: SyncStatus;
  flow?: Flow;
  q?: string;
  cursor?: string;
}

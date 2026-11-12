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
  reconciliation: null;
}

export interface SyncFilters {
  status?: SyncStatus;
  flow?: Flow;
  q?: string;
  cursor?: string;
}

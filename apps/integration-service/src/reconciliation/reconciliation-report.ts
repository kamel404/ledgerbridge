import type { ErpRecordType } from '../erp-client/erp-client.js';

/**
 * The record types reconciliation checks: the ones an event produces.
 * Customers and vendors are created on the side (by an invoice or a bill),
 * so they have no sync record of their own to compare with.
 */
export const RECONCILED_TYPES = ['invoice', 'customerPayment', 'vendorBill'] as const satisfies readonly ErpRecordType[];
export type ReconciledType = (typeof RECONCILED_TYPES)[number];

/**
 *   MISSING_IN_ERP           we logged SUCCEEDED, but the ERP has no record with that external ID
 *                            (deleted in the ERP by hand, or a write that never landed)
 *   MISSING_IN_LEDGERBRIDGE  the ERP has a record created in the window that no SUCCEEDED event
 *                            produced (entered by hand, or our log update failed after the write)
 *   ERP_ID_CHANGED           the external ID exists, but under another internal ID than we
 *                            stored (deleted and re-created in the ERP by hand)
 */
export type MismatchKind = 'MISSING_IN_ERP' | 'MISSING_IN_LEDGERBRIDGE' | 'ERP_ID_CHANGED';

export interface Mismatch {
  kind: MismatchKind;
  recordType: ReconciledType;
  /** The source system's ID, e.g. INV-1042: the business key on our side. */
  externalId: string;
  /** Internal ID in the ERP: the one we stored, or the one the ERP has. */
  erpRecordId?: string;
  /** The event that synced it (missing for MISSING_IN_LEDGERBRIDGE). */
  eventId?: string;
}

export interface TypeCounts {
  /** SUCCEEDED events in the window that produced this type. */
  synced: number;
  /** ERP records of this type created in the window. */
  createdInErp: number;
  /** Synced records found in the ERP under the stored internal ID. */
  matched: number;
}

/** One reconciliation run. The latest is shown on the dashboard's Overview. */
export interface ReconciliationReport {
  runAt: string;
  /** The window that was checked: [since, until]. */
  since: string;
  until: string;
  byType: Record<ReconciledType, TypeCounts>;
  /** All mismatches found, even when `mismatches` is cut short. */
  mismatchCount: number;
  /** The first MAX_STORED_MISMATCHES, so the stored item stays small. */
  mismatches: Mismatch[];
}

/** DynamoDB items are at most 400 KB; 100 mismatches is far below that. */
export const MAX_STORED_MISMATCHES = 100;

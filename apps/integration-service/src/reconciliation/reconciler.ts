import { Inject, Injectable, Logger } from '@nestjs/common';
import { ErpClient } from '../erp-client/erp-client.js';
import { SYNC_METRICS, type SyncMetrics } from '../observability/sync-metrics.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import type { SyncRef } from '../sync-log/sync-record.js';
import {
  MAX_STORED_MISMATCHES,
  RECONCILED_TYPES,
  type Mismatch,
  type ReconciledType,
  type ReconciliationReport,
  type TypeCounts,
} from './reconciliation-report.js';
import { RECONCILIATION_STORE, type ReconciliationStore } from './reconciliation-store.js';

const HOUR = 3600_000;
/** How far back a run looks. */
export const WINDOW_MS = 24 * HOUR;
/** The last few minutes are skipped: an event may be between its ERP write and its log update. */
export const SETTLE_MS = 5 * 60_000;
/**
 * Extra time read on the "other" side of each comparison, so a record near
 * the window's edge (clocks differ a little, a write and its log update are
 * a moment apart) is still found and not reported as missing.
 */
export const MARGIN_MS = HOUR;
/** SuiteQL page size (the most NetSuite returns per page). */
const PAGE_SIZE = 1000;
/** Safety stop: 50 pages = 50,000 records of one type in a day. */
const MAX_PAGES = 50;

interface ErpRow {
  id: string;
  externalid: string | null;
  createddate: string;
}

/**
 * Nightly check that the ERP holds what the sync log says was synced
 * (PLAN Phase 8). Both directions, per record type:
 *
 * 1. Every SUCCEEDED event in the window must have its record in the ERP,
 *    under the internal ID we stored.          -> MISSING_IN_ERP, ERP_ID_CHANGED
 * 2. Every ERP record created in the window must come from a SUCCEEDED
 *    event.                                    -> MISSING_IN_LEDGERBRIDGE
 *
 * Records are matched by external ID (our business key, e.g. INV-1042),
 * which is what every write upserts by.
 *
 * Each side is read once for the window plus a margin: the sync log through
 * its byStatus index, the ERP with one SuiteQL query per type. Upserts update
 * lastModifiedDate, so "modified since" catches every record we wrote.
 */
@Injectable()
export class Reconciler {
  private readonly logger = new Logger(Reconciler.name);

  constructor(
    private readonly syncLog: SyncLogService,
    private readonly erp: ErpClient,
    @Inject(RECONCILIATION_STORE) private readonly store: ReconciliationStore,
    @Inject(SYNC_METRICS) private readonly metrics: SyncMetrics,
  ) {}

  /**
   * `settleMs: 0` (manual runs, `npm run reconcile -- --include-recent`) checks right up to now, so an
   * event sent a minute ago is included. An event still in flight may then show as a mismatch.
   */
  async run(now = new Date(), { settleMs = SETTLE_MS }: { settleMs?: number } = {}): Promise<ReconciliationReport> {
    const until = new Date(now.getTime() - settleMs).toISOString();
    const since = new Date(now.getTime() - settleMs - WINDOW_MS).toISOString();
    const withMargin = new Date(Date.parse(since) - MARGIN_MS).toISOString();

    // Ours: everything from the margin on (no upper bound), latest event per record.
    const synced = latestPerRecord(await this.syncLog.succeededSince(withMargin));

    const byType = {} as Record<ReconciledType, TypeCounts>;
    const mismatches: Mismatch[] = [];
    for (const type of RECONCILED_TYPES) {
      const erpRows = await this.erpRecordsModifiedSince(type, withMargin);
      const erpByExternalId = new Map(erpRows.filter((r) => r.externalid).map((r) => [r.externalid!, r]));
      const ours = synced.get(type) ?? new Map<string, SyncRef>();
      const counts: TypeCounts = { synced: 0, createdInErp: 0, matched: 0 };

      // 1. Synced in the window -> must be in the ERP.
      for (const [externalId, ref] of ours) {
        if (ref.updatedAt < since || ref.updatedAt > until) continue;
        counts.synced++;
        const row = erpByExternalId.get(externalId);
        if (!row) {
          mismatches.push({ kind: 'MISSING_IN_ERP', recordType: type, externalId, eventId: ref.eventId, ...idOf(ref) });
        } else if (ref.erpRecordId && String(row.id) !== ref.erpRecordId) {
          mismatches.push({ kind: 'ERP_ID_CHANGED', recordType: type, externalId, eventId: ref.eventId, erpRecordId: String(row.id) });
        } else {
          counts.matched++;
        }
      }

      // 2. Created in the ERP in the window -> must come from a SUCCEEDED event.
      for (const row of erpRows) {
        if (row.createddate < since || row.createddate > until) continue;
        counts.createdInErp++;
        if (!row.externalid || !ours.has(row.externalid)) {
          mismatches.push({
            kind: 'MISSING_IN_LEDGERBRIDGE',
            recordType: type,
            externalId: row.externalid ?? '(none)',
            erpRecordId: String(row.id),
          });
        }
      }
      byType[type] = counts;
    }

    const report: ReconciliationReport = {
      runAt: now.toISOString(),
      since,
      until,
      byType,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, MAX_STORED_MISMATCHES),
    };
    await this.store.save(report);
    this.metrics.reconciled(mismatches.length);

    for (const m of report.mismatches) {
      this.logger.warn(`Mismatch ${m.kind}: ${m.recordType} ${m.externalId}${m.eventId ? ` (event ${m.eventId})` : ''}`);
    }
    const summary = `Reconciliation of ${since} to ${until}: ${mismatches.length} mismatch(es). ${JSON.stringify(byType)}`;
    if (mismatches.length) this.logger.warn(summary);
    else this.logger.log(summary);
    return report;
  }

  /**
   * Every record of a type modified at or after `sinceIso`, all pages.
   *
   * The mock's tables are named after the record types and compare ISO
   * timestamps as text. Real NetSuite keeps all three in the `transaction`
   * table (WHERE type = 'CustInvc' / 'CustPymt' / 'VendBill') and needs
   * TO_TIMESTAMP() for the date. Only this query would change.
   */
  private async erpRecordsModifiedSince(type: ReconciledType, sinceIso: string): Promise<ErpRow[]> {
    const q = `SELECT id, externalid, createddate FROM ${type} WHERE lastmodifieddate >= '${sinceIso}'`;
    const rows: ErpRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.erp.suiteql<ErpRow>(q, { limit: PAGE_SIZE, offset: rows.length });
      rows.push(...res.items);
      if (!res.hasMore || res.items.length === 0) return rows;
    }
    throw new Error(`Reconciliation stopped: more than ${MAX_PAGES * PAGE_SIZE} ${type} records changed in the window`);
  }
}

/**
 * type -> external ID -> the most recent SUCCEEDED event for that record.
 * The same invoice can be synced by several events (a resend with a new
 * event ID); the last one holds the current internal ID.
 */
function latestPerRecord(refs: SyncRef[]): Map<string, Map<string, SyncRef>> {
  const result = new Map<string, Map<string, SyncRef>>();
  for (const ref of refs) {
    if (!ref.erpRecordType || !ref.businessKey) continue;
    let perType = result.get(ref.erpRecordType);
    if (!perType) result.set(ref.erpRecordType, (perType = new Map()));
    const existing = perType.get(ref.businessKey);
    if (!existing || existing.updatedAt < ref.updatedAt) perType.set(ref.businessKey, ref);
  }
  return result;
}

const idOf = (ref: SyncRef) => (ref.erpRecordId ? { erpRecordId: ref.erpRecordId } : {});

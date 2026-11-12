import type { ErpClient, SuiteQlPage } from '../erp-client/erp-client.js';
import { InMemorySyncLogRepository } from '../sync-log/in-memory-sync-log.repository.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import type { SyncRecord } from '../sync-log/sync-record.js';
import { Reconciler } from './reconciler.js';
import { InMemoryReconciliationStore } from './reconciliation-store.js';

// A run at 02:00 checks 01:55 yesterday to 01:55 today (the last 5 minutes are still settling),
// and reads both sides from 00:55 yesterday (1 hour of margin).
const NOW = new Date('2026-11-13T02:00:00.000Z');
const IN_WINDOW = '2026-11-12T12:00:00.000Z';

interface Row {
  id: string;
  externalid: string | null;
  createddate: string;
  lastmodifieddate: string;
}

/** The mock ERP's SuiteQL, reduced to what the reconciler sends: one table, "lastmodifieddate >= '...'", paging. */
function fakeErp(tables: Record<string, Row[]>, pageSize?: number) {
  const queries: string[] = [];
  const suiteql = vi.fn(async (q: string, page: { limit?: number; offset?: number } = {}): Promise<SuiteQlPage> => {
    queries.push(q);
    const match = /FROM (\w+) WHERE lastmodifieddate >= '([^']+)'/.exec(q);
    if (!match) throw new Error(`unexpected query: ${q}`);
    const rows = (tables[match[1]!] ?? []).filter((r) => r.lastmodifieddate >= match[2]!);
    const offset = page.offset ?? 0;
    const items = rows.slice(offset, offset + (pageSize ?? page.limit ?? 1000));
    return {
      items: items.map(({ id, externalid, createddate }) => ({ id, externalid, createddate })),
      count: items.length,
      offset,
      totalResults: rows.length,
      hasMore: offset + items.length < rows.length,
    };
  });
  return { erp: { suiteql } as unknown as ErpClient, queries, suiteql };
}

const erpRow = (id: string, externalid: string | null, createddate = IN_WINDOW, lastmodifieddate = createddate): Row => ({
  id,
  externalid,
  createddate,
  lastmodifieddate,
});

function synced(eventId: string, erpRecordType: string, businessKey: string, erpRecordId: string, updatedAt = IN_WINDOW): SyncRecord {
  return {
    eventId,
    source: 'billing',
    flow: erpRecordType === 'vendorBill' ? 'P2P' : 'O2C',
    status: 'SUCCEEDED',
    attempts: 1,
    businessKey,
    erpRecordType,
    erpRecordId,
    payload: {},
    receivedAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
    ttl: 0,
    history: [],
  };
}

async function setup(records: SyncRecord[], tables: Record<string, Row[]>, pageSize?: number) {
  const repo = new InMemorySyncLogRepository();
  for (const r of records) await repo.create(r);
  const store = new InMemoryReconciliationStore();
  const metrics = { attempt: vi.fn(), dead: vi.fn(), reconciled: vi.fn() };
  const fake = fakeErp(tables, pageSize);
  const reconciler = new Reconciler(new SyncLogService(repo), fake.erp, store, metrics);
  return { reconciler, store, metrics, ...fake };
}

describe('Reconciler', () => {
  it('finds nothing when both sides agree, and stores the run', async () => {
    const { reconciler, store, metrics, queries } = await setup(
      [
        synced('e1', 'invoice', 'INV-1', '10'),
        synced('e2', 'customerPayment', 'PAY-1', '20'),
        synced('e3', 'vendorBill', 'BILL-1', '30'),
      ],
      {
        invoice: [erpRow('10', 'INV-1')],
        customerPayment: [erpRow('20', 'PAY-1')],
        vendorBill: [erpRow('30', 'BILL-1')],
      },
    );

    const report = await reconciler.run(NOW);

    expect(report).toMatchObject({
      runAt: '2026-11-13T02:00:00.000Z',
      since: '2026-11-12T01:55:00.000Z',
      until: '2026-11-13T01:55:00.000Z',
      mismatchCount: 0,
      mismatches: [],
    });
    expect(report.byType.invoice).toEqual({ synced: 1, createdInErp: 1, matched: 1 });
    expect(report.byType.vendorBill).toEqual({ synced: 1, createdInErp: 1, matched: 1 });
    expect(queries).toEqual([
      "SELECT id, externalid, createddate FROM invoice WHERE lastmodifieddate >= '2026-11-12T00:55:00.000Z'",
      "SELECT id, externalid, createddate FROM customerPayment WHERE lastmodifieddate >= '2026-11-12T00:55:00.000Z'",
      "SELECT id, externalid, createddate FROM vendorBill WHERE lastmodifieddate >= '2026-11-12T00:55:00.000Z'",
    ]);
    expect(await store.latest()).toEqual(report);
    expect(metrics.reconciled).toHaveBeenCalledWith(0);
  });

  it('flags a synced invoice that was deleted in the ERP', async () => {
    const { reconciler, metrics } = await setup([synced('e1', 'invoice', 'INV-1', '10'), synced('e2', 'invoice', 'INV-2', '11')], {
      invoice: [erpRow('11', 'INV-2')],
    });

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([
      { kind: 'MISSING_IN_ERP', recordType: 'invoice', externalId: 'INV-1', eventId: 'e1', erpRecordId: '10' },
    ]);
    expect(report.byType.invoice).toEqual({ synced: 2, createdInErp: 1, matched: 1 });
    expect(metrics.reconciled).toHaveBeenCalledWith(1);
  });

  it('flags an ERP record that no SUCCEEDED event produced', async () => {
    const { reconciler } = await setup([], { vendorBill: [erpRow('30', 'BILL-BY-HAND'), erpRow('31', null)] });

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([
      { kind: 'MISSING_IN_LEDGERBRIDGE', recordType: 'vendorBill', externalId: 'BILL-BY-HAND', erpRecordId: '30' },
      { kind: 'MISSING_IN_LEDGERBRIDGE', recordType: 'vendorBill', externalId: '(none)', erpRecordId: '31' },
    ]);
  });

  it('flags a record that was re-created in the ERP under a new internal ID', async () => {
    const { reconciler } = await setup([synced('e1', 'invoice', 'INV-1', '10')], {
      invoice: [erpRow('99', 'INV-1', '2026-11-11T08:00:00.000Z', IN_WINDOW)],
    });

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([
      { kind: 'ERP_ID_CHANGED', recordType: 'invoice', externalId: 'INV-1', eventId: 'e1', erpRecordId: '99' },
    ]);
  });

  it('flags a record whose event did not end SUCCEEDED (the ERP write landed, the log update did not)', async () => {
    const dead = { ...synced('e1', 'invoice', 'INV-1', '10'), status: 'DEAD' as const };
    const { reconciler } = await setup([dead], { invoice: [erpRow('10', 'INV-1')] });

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([
      { kind: 'MISSING_IN_LEDGERBRIDGE', recordType: 'invoice', externalId: 'INV-1', erpRecordId: '10' },
    ]);
  });

  it('does not flag records at the edges of the window', async () => {
    const { reconciler } = await setup(
      [
        // Logged a moment before the window starts, created in the ERP a moment after: matched through the margin.
        synced('e1', 'invoice', 'INV-EDGE', '10', '2026-11-12T01:54:59.000Z'),
        // Logged in the last 5 minutes: still settling, checked tomorrow.
        synced('e2', 'invoice', 'INV-NEW', '12', '2026-11-13T01:58:00.000Z'),
      ],
      {
        invoice: [
          erpRow('10', 'INV-EDGE', '2026-11-12T01:55:01.000Z'),
          // Created in the last 5 minutes, its event isn't logged yet.
          erpRow('11', 'INV-IN-FLIGHT', '2026-11-13T01:57:00.000Z'),
          // Created long ago and last changed long ago: outside the window on both sides.
          erpRow('5', 'INV-OLD', '2026-11-01T00:00:00.000Z'),
        ],
      },
    );

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([]);
    expect(report.byType.invoice).toEqual({ synced: 0, createdInErp: 1, matched: 0 });
  });

  it('compares with the latest event when one record was synced by several events', async () => {
    const { reconciler } = await setup(
      [
        synced('old', 'invoice', 'INV-1', '10', '2026-11-12T03:00:00.000Z'),
        synced('resend', 'invoice', 'INV-1', '15', '2026-11-12T09:00:00.000Z'),
      ],
      { invoice: [erpRow('15', 'INV-1', '2026-11-12T08:59:00.000Z')] },
    );

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([]);
    expect(report.byType.invoice).toEqual({ synced: 1, createdInErp: 1, matched: 1 });
  });

  it('reads every SuiteQL page', async () => {
    const records = Array.from({ length: 5 }, (_, i) => synced(`e${i}`, 'invoice', `INV-${i}`, String(i + 1)));
    const rows = records.map((r) => erpRow(r.erpRecordId!, r.businessKey!));
    const { reconciler, suiteql } = await setup(records, { invoice: rows }, 2);

    const report = await reconciler.run(NOW);

    expect(report.mismatches).toEqual([]);
    expect(report.byType.invoice.matched).toBe(5);
    const invoiceOffsets = suiteql.mock.calls.filter(([q]) => q.includes('FROM invoice')).map(([, page]) => page?.offset);
    expect(invoiceOffsets).toEqual([0, 2, 4]);
  });

  it('stores at most 100 mismatches but counts them all', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => erpRow(String(i + 1), `INV-HAND-${i}`));
    const { reconciler, metrics } = await setup([], { invoice: rows });

    const report = await reconciler.run(NOW);

    expect(report.mismatchCount).toBe(120);
    expect(report.mismatches).toHaveLength(100);
    expect(metrics.reconciled).toHaveBeenCalledWith(120);
  });

  it('fails the run instead of storing a half-checked result when the ERP is down', async () => {
    const { reconciler, store, suiteql, metrics } = await setup([synced('e1', 'invoice', 'INV-1', '10')], {});
    suiteql.mockRejectedValueOnce(new Error('ERP_SERVICE_UNAVAILABLE'));

    await expect(reconciler.run(NOW)).rejects.toThrow('ERP_SERVICE_UNAVAILABLE');
    expect(await store.latest()).toBeUndefined();
    expect(metrics.reconciled).not.toHaveBeenCalled();
  });
});

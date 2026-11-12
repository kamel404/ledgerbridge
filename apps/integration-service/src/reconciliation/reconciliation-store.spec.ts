import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ReconciliationReport } from './reconciliation-report.js';
import { DynamoDbReconciliationStore } from './reconciliation-store.js';

const report: ReconciliationReport = {
  runAt: '2026-11-13T02:00:00.000Z',
  since: '2026-11-12T01:55:00.000Z',
  until: '2026-11-13T01:55:00.000Z',
  byType: {
    invoice: { synced: 1, createdInErp: 0, matched: 0 },
    customerPayment: { synced: 0, createdInErp: 0, matched: 0 },
    vendorBill: { synced: 0, createdInErp: 0, matched: 0 },
  },
  mismatchCount: 1,
  mismatches: [{ kind: 'MISSING_IN_ERP', recordType: 'invoice', externalId: 'INV-1', eventId: 'e1' }],
};

function fakeDb(getItem?: Record<string, unknown>) {
  const inputs: Array<Record<string, unknown>> = [];
  const db = {
    send: vi.fn(async (cmd: { input: Record<string, unknown> }) => {
      inputs.push(cmd.input);
      return { Item: getItem };
    }),
  } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  return { db, inputs };
}

describe('DynamoDbReconciliationStore', () => {
  it('writes the run to its history (with a 90-day TTL) and as "latest"', async () => {
    const { db, inputs } = fakeDb();
    await new DynamoDbReconciliationStore(undefined, 'Reconciliation', db).save(report);

    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      TableName: 'Reconciliation',
      Item: { runId: 'run#2026-11-13T02:00:00.000Z', ttl: Date.parse(report.runAt) / 1000 + 90 * 24 * 3600, mismatchCount: 1 },
    });
    expect(inputs[1]).toMatchObject({ Item: { runId: 'latest', mismatchCount: 1 } });
    expect(inputs[1]!.Item).not.toHaveProperty('ttl');
  });

  it('reads "latest" back without the key', async () => {
    const { db, inputs } = fakeDb({ runId: 'latest', ...report });
    expect(await new DynamoDbReconciliationStore(undefined, 'Reconciliation', db).latest()).toEqual(report);
    expect(inputs[0]).toMatchObject({ Key: { runId: 'latest' } });
  });

  it('returns undefined before the first run', async () => {
    const { db } = fakeDb(undefined);
    expect(await new DynamoDbReconciliationStore(undefined, 'Reconciliation', db).latest()).toBeUndefined();
  });
});

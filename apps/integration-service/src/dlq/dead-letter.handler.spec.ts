import type { SQSRecord } from 'aws-lambda';
import { InMemorySyncLogRepository } from '../sync-log/in-memory-sync-log.repository.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import { invoiceEvent } from '../test-support/events.js';
import { DeadLetterHandler } from './dead-letter.handler.js';

function record(id: string, body: string): SQSRecord {
  return { messageId: id, body, attributes: {} } as SQSRecord;
}

async function setup(status?: 'RETRYING' | 'SUCCEEDED') {
  const syncLog = new SyncLogService(new InMemorySyncLogRepository());
  const event = invoiceEvent();
  await syncLog.received({ eventId: event.id, source: 'billing', flow: 'O2C', eventType: event.type, businessKey: 'INV-1042', payload: event });
  if (status) {
    await syncLog.transition(event.id, status, {
      attempts: 4,
      lastError: { code: 'ERP_SERVICE_UNAVAILABLE', message: 'down', class: 'retryable' },
    });
  }
  return { syncLog, handler: new DeadLetterHandler(syncLog), body: JSON.stringify({ eventId: event.id, event }) };
}

describe('DeadLetterHandler', () => {
  it('marks a RETRYING event DEAD and keeps its last error', async () => {
    const t = await setup('RETRYING');
    await expect(t.handler.handle([record('m1', t.body)])).resolves.toEqual({ batchItemFailures: [] });
    const rec = await t.syncLog.get('evt_inv_1');
    expect(rec).toMatchObject({ status: 'DEAD', attempts: 4, lastError: { code: 'ERP_SERVICE_UNAVAILABLE' } });
    expect(rec!.history.at(-1)).toMatchObject({ status: 'DEAD', note: 'DLQ after 4 attempt(s)' });
  });

  it('leaves an event that already succeeded alone', async () => {
    const t = await setup('SUCCEEDED');
    await t.handler.handle([record('m1', t.body)]);
    expect((await t.syncLog.get('evt_inv_1'))!.status).toBe('SUCCEEDED');
  });

  it('drops messages it cannot use without failing the batch', async () => {
    const t = await setup('RETRYING');
    const res = await t.handler.handle([
      record('m1', 'not json'),
      record('m2', JSON.stringify({ eventId: 'evt_unknown' })),
      record('m3', t.body),
    ]);
    expect(res.batchItemFailures).toEqual([]);
    expect((await t.syncLog.get('evt_inv_1'))!.status).toBe('DEAD');
  });

  it('reports a message whose record could not be updated, so it is tried again', async () => {
    const t = await setup('RETRYING');
    vi.spyOn(t.syncLog, 'transition').mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await expect(t.handler.handle([record('m1', t.body)])).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
  });
});

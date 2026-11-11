import type { LedgerEvent } from '@ledgerbridge/shared';
import { PermanentError, RetryableError } from '../errors/integration-errors.js';
import type { FlowRegistry } from '../flows/flow-registry.js';
import { InMemorySyncLogRepository } from '../sync-log/in-memory-sync-log.repository.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import { invoiceEvent } from '../test-support/events.js';
import { SyncWorker } from './sync-worker.js';

function setup(processEvent: (event: LedgerEvent) => Promise<unknown>) {
  const repo = new InMemorySyncLogRepository();
  const syncLog = new SyncLogService(repo);
  const flows = { processEvent: vi.fn(processEvent) } as unknown as FlowRegistry;
  const worker = new SyncWorker(flows, syncLog);
  const event = invoiceEvent();
  const receive = () =>
    syncLog.received({
      eventId: event.id,
      source: 'billing',
      flow: 'O2C',
      eventType: event.type,
      businessKey: 'INV-1042',
      payload: event,
    });
  return { repo, syncLog, flows, worker, event, receive };
}

describe('SyncWorker', () => {
  it('marks a successful event SUCCEEDED with the ERP record', async () => {
    const t = setup(async () => ({ erpRecordType: 'invoice', erpRecordId: '42' }));
    await t.receive();

    await expect(t.worker.process(t.event.id, t.event)).resolves.toEqual({ status: 'SUCCEEDED' });

    const record = await t.syncLog.get(t.event.id);
    expect(record).toMatchObject({ status: 'SUCCEEDED', attempts: 1, erpRecordType: 'invoice', erpRecordId: '42' });
    expect(record!.completedAt).toBeDefined();
    expect(record!.history.map((h) => h.status)).toEqual(['RECEIVED', 'PROCESSING', 'SUCCEEDED']);
  });

  it('marks a retryable failure RETRYING and passes Retry-After on', async () => {
    const t = setup(async () => {
      throw new RetryableError('ERP_RATE_LIMITED', 'slow down', { retryAfterSeconds: 3 });
    });
    await t.receive();

    const outcome = await t.worker.process(t.event.id, t.event);

    expect(outcome).toMatchObject({ status: 'RETRYING', retryAfterSeconds: 3, error: { class: 'retryable' } });
    expect(await t.syncLog.get(t.event.id)).toMatchObject({
      status: 'RETRYING',
      lastError: { code: 'ERP_RATE_LIMITED', message: 'slow down', class: 'retryable' },
    });
  });

  it('marks a permanent failure FAILED', async () => {
    const t = setup(async () => {
      throw new PermanentError('UNKNOWN_SKU', 'no such sku');
    });
    await t.receive();

    await expect(t.worker.process(t.event.id, t.event)).resolves.toMatchObject({ status: 'FAILED' });
    const record = await t.syncLog.get(t.event.id);
    expect(record).toMatchObject({ status: 'FAILED', lastError: { code: 'UNKNOWN_SKU', class: 'permanent' } });
    expect(record!.history.at(-1)).toMatchObject({ status: 'FAILED', note: 'UNKNOWN_SKU' });
  });

  it('counts attempts across retries', async () => {
    let calls = 0;
    const t = setup(async () => {
      if (++calls < 3) throw new RetryableError('INVOICE_NOT_FOUND', 'not yet');
      return { erpRecordType: 'customerPayment', erpRecordId: '9' };
    });
    await t.receive();

    for (let i = 0; i < 3; i++) await t.worker.process(t.event.id, t.event);

    expect(await t.syncLog.get(t.event.id)).toMatchObject({ status: 'SUCCEEDED', attempts: 3 });
  });

  it('skips an event that already SUCCEEDED (event-level idempotency)', async () => {
    const t = setup(async () => ({ erpRecordType: 'invoice', erpRecordId: '42' }));
    await t.receive();
    await t.worker.process(t.event.id, t.event);

    await expect(t.worker.process(t.event.id, t.event)).resolves.toEqual({ status: 'SUCCEEDED', skipped: true });
    expect(t.flows.processEvent).toHaveBeenCalledTimes(1);
    expect(await t.syncLog.get(t.event.id)).toMatchObject({ attempts: 1 });
  });
});

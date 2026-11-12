import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule as MockErpModule } from '../../mock-erp/src/app.module.js';
import { MOCK_ERP_CONFIG, loadConfig as loadErpConfig } from '../../mock-erp/src/config/mock-erp.config.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.factory.js';
import { INTEGRATION_CONFIG, loadConfig } from '../src/config/integration.config.js';
import { EVENT_DISPATCHER } from '../src/ingest/event-dispatcher.js';
import { computeSignature } from '../src/ingest/signature.js';
import { EnvSecretsProvider } from '../src/secrets/env-secrets.provider.js';
import { SECRETS_PROVIDER } from '../src/secrets/secrets-provider.js';
import type { InMemorySyncLogRepository } from '../src/sync-log/in-memory-sync-log.repository.js';
import { SYNC_LOG_REPOSITORY } from '../src/sync-log/sync-record.js';
import { invoiceEvent, paymentEvent } from '../src/test-support/events.js';
import { SqsBatchHandler } from '../src/worker/sqs-batch-handler.js';
import { SyncWorker } from '../src/worker/sync-worker.js';
import { FakeQueue } from './support/fake-queue.js';

const erpConfig = loadErpConfig({ RATE_LIMIT_PER_SECOND: '0' });
const SECRET = 'test-billing-secret';

/**
 * Phase 4, locally (SPEC §12 "Integration"): signed webhook -> queue -> worker
 * batch handler -> real mock ERP. Same event twice must give one ERP record;
 * a payment before its invoice must eventually succeed.
 */
describe('Worker with a queue (e2e, with the mock ERP)', () => {
  let erp: INestApplication;
  let app: INestApplication;
  let syncLog: InMemorySyncLogRepository;
  let queue: FakeQueue;
  let handler: SqsBatchHandler;
  let erpToken: string;

  beforeAll(async () => {
    const erpRef = await Test.createTestingModule({ imports: [MockErpModule] })
      .overrideProvider(MOCK_ERP_CONFIG)
      .useValue(erpConfig)
      .compile();
    erp = erpRef.createNestApplication();
    await erp.listen(0, '127.0.0.1');
    const erpUrl = `http://127.0.0.1:${(erp.getHttpServer().address() as AddressInfo).port}`;

    queue = new FakeQueue();
    const appRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(INTEGRATION_CONFIG)
      .useValue(loadConfig({ ERP_BASE_URL: erpUrl }))
      .overrideProvider(SECRETS_PROVIDER)
      .useValue(
        new EnvSecretsProvider({
          WEBHOOK_SECRET_BILLING: SECRET,
          WEBHOOK_SECRET_PROCUREMENT: 'unused',
          MOCK_ERP_CLIENT_ID: erpConfig.clientId,
          MOCK_ERP_CLIENT_SECRET: erpConfig.clientSecret,
        }),
      )
      .overrideProvider(EVENT_DISPATCHER)
      .useValue(queue)
      .compile();
    app = appRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    syncLog = app.get(SYNC_LOG_REPOSITORY);
    handler = new SqsBatchHandler(app.get(SyncWorker), queue.changeVisibility);

    const res = await request(erp.getHttpServer())
      .post('/services/rest/auth/oauth2/v1/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: erpConfig.clientId, client_secret: erpConfig.clientSecret });
    erpToken = res.body.access_token;
  });

  afterAll(async () => {
    await app?.close();
    await erp?.close();
  });

  function webhook(body: unknown) {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app.getHttpServer())
      .post('/webhooks/billing')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', ts)
      .set('X-Signature', computeSignature(SECRET, ts, raw))
      .send(raw);
  }

  const countInErp = async (type: string, externalId: string) =>
    (
      await request(erp.getHttpServer())
        .post('/services/rest/query/v1/suiteql')
        .set('Authorization', `Bearer ${erpToken}`)
        .set('Prefer', 'transient')
        .send({ q: `SELECT id FROM ${type} WHERE externalId = '${externalId}'` })
        .expect(200)
    ).body.totalResults as number;

  const chaos = (settings: { errorRate: number }) =>
    request(erp.getHttpServer()).put('/mock/chaos').set('Authorization', `Bearer ${erpToken}`).send(settings).expect(200);

  it('queues the event: 202 { syncId } with no ERP call yet', async () => {
    const event = { ...invoiceEvent({ invoiceId: 'INV-Q1' }), id: 'evt_q1' };
    await webhook(event).expect(202, { syncId: 'evt_q1', status: 'RECEIVED' });
    expect(queue.depth).toBe(1);
    expect(await countInErp('invoice', 'INV-Q1')).toBe(0);

    await queue.drain(handler);
    expect(await syncLog.get('evt_q1')).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(await countInErp('invoice', 'INV-Q1')).toBe(1);
  });

  it('same event sent three times: one sync record, one ERP record', async () => {
    const event = { ...invoiceEvent({ invoiceId: 'INV-DUP' }), id: 'evt_dup' };
    await webhook(event).expect(202);
    await webhook(event).expect(200, { syncId: 'evt_dup', duplicate: true });
    await webhook(event).expect(200, { syncId: 'evt_dup', duplicate: true });
    expect(queue.depth).toBe(1);

    await queue.drain(handler);
    expect(await countInErp('invoice', 'INV-DUP')).toBe(1);
    expect(await syncLog.get('evt_dup')).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
  });

  it('SQS delivering a message twice is harmless (event-level skip)', async () => {
    const event = { ...invoiceEvent({ invoiceId: 'INV-TWICE' }), id: 'evt_twice' };
    await webhook(event).expect(202);
    queue.send({ eventId: 'evt_twice', event }); // the "at least once" duplicate

    await queue.drain(handler);
    expect(await countInErp('invoice', 'INV-TWICE')).toBe(1);
    expect(await syncLog.get('evt_twice')).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
  });

  it('a payment before its invoice is retried and ends SUCCEEDED', async () => {
    const invoice = { ...invoiceEvent({ invoiceId: 'INV-OOO', customer: { id: 'CUS-OOO', name: 'Late Co' } }), id: 'evt_ooo_inv' };
    const payment = {
      ...paymentEvent({ paymentId: 'PAY-OOO', invoiceId: 'INV-OOO', customerId: 'CUS-OOO' }),
      id: 'evt_ooo_pay',
    };

    await webhook(payment).expect(202);
    await queue.deliverVisible(handler); // only the payment: it can't succeed yet
    expect(queue.depth).toBe(1); // still queued, waiting for its retry
    expect(await syncLog.get('evt_ooo_pay')).toMatchObject({ status: 'RETRYING', lastError: { code: 'INVOICE_NOT_FOUND' } });
    expect(queue.delays.at(-1)).toBe(10);

    await webhook(invoice).expect(202);
    await queue.drain(handler);

    const record = await syncLog.get('evt_ooo_pay');
    expect(record!.status).toBe('SUCCEEDED');
    expect(record!.attempts).toBeGreaterThan(1);
    expect(await countInErp('customerPayment', 'PAY-OOO')).toBe(1);
    expect(queue.dlq).toEqual([]);
  });

  it('an ERP that stays down: RETRYING 4 times, then the message is in the DLQ', async () => {
    await chaos({ errorRate: 1 });
    try {
      await webhook({ ...invoiceEvent({ invoiceId: 'INV-DOWN' }), id: 'evt_down' }).expect(202);
      await queue.drain(handler);
    } finally {
      await chaos({ errorRate: 0 });
    }
    expect(queue.dlq).toHaveLength(1);
    expect(await syncLog.get('evt_down')).toMatchObject({
      status: 'RETRYING', // Phase 5's DLQ handler turns this into DEAD
      attempts: 4,
      lastError: { class: 'retryable' },
    });
  });

  it('a permanent failure is not retried', async () => {
    const event = { ...invoiceEvent({ invoiceId: 'INV-BADSKU', lines: [{ sku: 'NOPE', quantity: 1, unitPrice: 1 }] }), id: 'evt_badsku' };
    await webhook(event).expect(202);
    await queue.drain(handler);
    expect(await syncLog.get('evt_badsku')).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(queue.dlq).toHaveLength(1); // only the one from the previous test
  });
});

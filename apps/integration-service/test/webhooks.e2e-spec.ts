import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
// The real mock ERP, started in-process: the client's calls must match its routes (contract).
import { AppModule as MockErpModule } from '../../mock-erp/src/app.module.js';
import { MOCK_ERP_CONFIG, loadConfig as loadErpConfig } from '../../mock-erp/src/config/mock-erp.config.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.factory.js';
import { INTEGRATION_CONFIG, loadConfig } from '../src/config/integration.config.js';
import { computeSignature } from '../src/ingest/signature.js';
import { EnvSecretsProvider } from '../src/secrets/env-secrets.provider.js';
import { SECRETS_PROVIDER } from '../src/secrets/secrets-provider.js';
import type { InMemorySyncLogRepository } from '../src/sync-log/in-memory-sync-log.repository.js';
import { SYNC_LOG_REPOSITORY } from '../src/sync-log/sync-record.js';
import { billEvent, invoiceEvent, paymentEvent } from '../src/test-support/events.js';

const erpConfig = loadErpConfig({ RATE_LIMIT_PER_SECOND: '0' });
const SECRETS = { billing: 'test-billing-secret', procurement: 'test-procurement-secret' };

/**
 * Phase 2 over real HTTP: signed webhook -> mapping -> mock ERP, and every
 * rejection path. The worker runs inline (no queue yet).
 */
describe('Webhooks (e2e, with the mock ERP)', () => {
  let erp: INestApplication;
  let app: INestApplication;
  let syncLog: InMemorySyncLogRepository;
  let erpToken: string;

  beforeAll(async () => {
    const erpRef = await Test.createTestingModule({ imports: [MockErpModule] })
      .overrideProvider(MOCK_ERP_CONFIG)
      .useValue(erpConfig)
      .compile();
    erp = erpRef.createNestApplication();
    await erp.listen(0, '127.0.0.1');
    const erpUrl = `http://127.0.0.1:${(erp.getHttpServer().address() as AddressInfo).port}`;

    const appRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(INTEGRATION_CONFIG)
      .useValue(loadConfig({ ERP_BASE_URL: erpUrl }))
      .overrideProvider(SECRETS_PROVIDER)
      .useValue(
        new EnvSecretsProvider({
          WEBHOOK_SECRET_BILLING: SECRETS.billing,
          WEBHOOK_SECRET_PROCUREMENT: SECRETS.procurement,
          MOCK_ERP_CLIENT_ID: erpConfig.clientId,
          MOCK_ERP_CLIENT_SECRET: erpConfig.clientSecret,
        }),
      )
      .compile();
    app = appRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    syncLog = app.get(SYNC_LOG_REPOSITORY);

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

  /** Sends a correctly signed webhook. `body` may be an object or a raw string. */
  function webhook(source: 'billing' | 'procurement', body: unknown, opts: { secret?: string; timestamp?: number } = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    return request(app.getHttpServer())
      .post(`/webhooks/${source}`)
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', ts)
      .set('X-Signature', computeSignature(opts.secret ?? SECRETS[source], ts, raw))
      .send(raw);
  }

  const erpRecord = (type: string, externalId: string) =>
    request(erp.getHttpServer())
      .get(`/services/rest/record/v1/${type}/eid:${externalId}`)
      .set('Authorization', `Bearer ${erpToken}`);

  const suiteql = (q: string) =>
    request(erp.getHttpServer())
      .post('/services/rest/query/v1/suiteql')
      .set('Authorization', `Bearer ${erpToken}`)
      .set('Prefer', 'transient')
      .send({ q });

  describe('Order-to-Cash', () => {
    it('syncs an invoice: customer + invoice in the ERP, sync record SUCCEEDED', async () => {
      const res = await webhook('billing', invoiceEvent()).expect(202);
      expect(res.body).toEqual({ syncId: 'evt_inv_1', status: 'SUCCEEDED' });

      const invoice = await erpRecord('invoice', 'INV-1042').expect(200);
      expect(invoice.body).toMatchObject({
        tranId: 'INV-1042',
        entity: { externalId: 'CUS-77', refName: 'Cedar Logistics SAL' },
        total: 147,
        amountRemaining: 147,
        status: 'open',
      });
      expect((await erpRecord('customer', 'CUS-77').expect(200)).body).toMatchObject({ email: 'ap@cedar.example' });

      expect(await syncLog.get('evt_inv_1')).toMatchObject({
        status: 'SUCCEEDED',
        source: 'billing',
        flow: 'O2C',
        businessKey: 'INV-1042',
        erpRecordType: 'invoice',
        erpRecordId: invoice.body.id,
      });
    });

    it('syncs the payment and the invoice becomes paidInFull', async () => {
      await webhook('billing', paymentEvent()).expect(202, { syncId: 'evt_pay_1', status: 'SUCCEEDED' });

      const invoice = await erpRecord('invoice', 'INV-1042').expect(200);
      expect(invoice.body).toMatchObject({ amountPaid: 147, amountRemaining: 0, status: 'paidInFull' });
    });

    it('answers a repeated event ID with 200 and does nothing', async () => {
      await webhook('billing', invoiceEvent()).expect(200, { syncId: 'evt_inv_1', duplicate: true });
      const res = await suiteql("SELECT id FROM invoice WHERE externalId = 'INV-1042'").expect(200);
      expect(res.body.totalResults).toBe(1);
    });

    it('a new event for the same invoice still leaves one ERP record (upsert by external ID)', async () => {
      await webhook('billing', { ...invoiceEvent(), id: 'evt_inv_1_again' }).expect(202, {
        syncId: 'evt_inv_1_again',
        status: 'SUCCEEDED',
      });
      const res = await suiteql("SELECT id FROM invoice WHERE externalId = 'INV-1042'").expect(200);
      expect(res.body.totalResults).toBe(1);
    });

    it('a payment before its invoice is retryable (the queue retries it from Phase 4)', async () => {
      const early = { ...paymentEvent({ paymentId: 'PAY-EARLY', invoiceId: 'INV-LATER' }), id: 'evt_pay_early' };
      await webhook('billing', early).expect(202, { syncId: 'evt_pay_early', status: 'RETRYING' });
      expect(await syncLog.get('evt_pay_early')).toMatchObject({
        attempts: 1,
        lastError: { code: 'INVOICE_NOT_FOUND', class: 'retryable' },
      });
    });

    it('an overpayment fails permanently and the ERP is unchanged', async () => {
      await webhook('billing', { ...invoiceEvent({ invoiceId: 'INV-2000' }), id: 'evt_inv_2000' }).expect(202);
      const over = { ...paymentEvent({ paymentId: 'PAY-OVER', invoiceId: 'INV-2000', amount: 500 }), id: 'evt_over' };

      await webhook('billing', over).expect(202, { syncId: 'evt_over', status: 'FAILED' });

      expect(await syncLog.get('evt_over')).toMatchObject({ lastError: { code: 'PAYMENT_EXCEEDS_BALANCE' } });
      await erpRecord('customerPayment', 'PAY-OVER').expect(404);
    });
  });

  describe('Procure-to-Pay', () => {
    it('syncs a bill: vendor + vendor bill', async () => {
      await webhook('procurement', billEvent()).expect(202, { syncId: 'evt_bill_1', status: 'SUCCEEDED' });
      expect((await erpRecord('vendorBill', 'BILL-2209').expect(200)).body).toMatchObject({
        entity: { externalId: 'VEN-12' },
        total: 240,
      });
    });

    it('an unknown expense category fails permanently and writes nothing', async () => {
      const event = {
        ...billEvent({ billNumber: 'BILL-X', vendor: { id: 'VEN-X', name: 'X' }, lines: [{ expenseCategory: 'YACHTS', amount: 9 }] }),
        id: 'evt_bill_x',
      };
      await webhook('procurement', event).expect(202, { syncId: 'evt_bill_x', status: 'FAILED' });
      expect(await syncLog.get('evt_bill_x')).toMatchObject({
        lastError: { code: 'UNKNOWN_EXPENSE_CATEGORY', class: 'permanent' },
      });
      await erpRecord('vendor', 'VEN-X').expect(404);
    });
  });

  describe('rejections', () => {
    it('401 for a wrong signature, and nothing is logged', async () => {
      const event = { ...invoiceEvent(), id: 'evt_forged' };
      const res = await webhook('billing', event, { secret: 'wrong' }).expect(401);
      expect(res.body.reason).toBe('INVALID_SIGNATURE');
      expect(await syncLog.get('evt_forged')).toBeUndefined();
    });

    it('401 for a body signed with the other source secret', async () => {
      await webhook('billing', invoiceEvent(), { secret: SECRETS.procurement }).expect(401);
    });

    it('401 for a timestamp older than 5 minutes', async () => {
      const res = await webhook('billing', invoiceEvent(), { timestamp: Math.floor(Date.now() / 1000) - 301 }).expect(401);
      expect(res.body.reason).toBe('TIMESTAMP_OUT_OF_RANGE');
    });

    it('401 without signature headers', async () => {
      await request(app.getHttpServer()).post('/webhooks/billing').send(invoiceEvent()).expect(401);
    });

    it('404 for an unknown source', async () => {
      await request(app.getHttpServer()).post('/webhooks/crm').send({}).expect(404);
    });

    it('400 + REJECTED record for a payload that fails the schema', async () => {
      const bad = { id: 'evt_bad', type: 'invoice.created', occurredAt: '2026-11-11T09:30:00Z', data: { invoiceId: 'INV-9' } };
      const res = await webhook('billing', bad).expect(400);
      expect(res.body).toMatchObject({ syncId: 'evt_bad', error: 'INVALID_PAYLOAD' });
      expect(res.body.message).toContain('data.customer');
      expect(await syncLog.get('evt_bad')).toMatchObject({
        status: 'REJECTED',
        flow: 'O2C',
        eventType: 'invoice.created',
        lastError: { code: 'INVALID_PAYLOAD', class: 'permanent' },
        payload: bad,
      });
    });

    it('400 + REJECTED record for a body that is not JSON (flow taken from the route)', async () => {
      const res = await webhook('procurement', '{"id": "evt_broken", ').expect(400);
      expect(res.body.error).toBe('INVALID_JSON');
      expect(await syncLog.get(res.body.syncId)).toMatchObject({
        status: 'REJECTED',
        source: 'procurement',
        flow: 'P2P',
        payload: '{"id": "evt_broken", ',
      });
    });

    it('400 for an event sent to the wrong source', async () => {
      const res = await webhook('procurement', { ...invoiceEvent(), id: 'evt_wrong_src' }).expect(400);
      expect(res.body.error).toBe('WRONG_SOURCE');
    });

    it('a rejected payload reusing an existing event ID does not overwrite the real record', async () => {
      const res = await webhook('billing', { id: 'evt_inv_1', type: 'invoice.created' }).expect(400);
      expect(res.body.syncId).toMatch(/^evt_inv_1:rejected:/);
      expect(await syncLog.get('evt_inv_1')).toMatchObject({ status: 'SUCCEEDED' });
    });
  });
});

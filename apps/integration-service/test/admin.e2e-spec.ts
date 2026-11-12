import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { SQSRecord } from 'aws-lambda';
import request from 'supertest';
import { AppModule as MockErpModule } from '../../mock-erp/src/app.module.js';
import { MOCK_ERP_CONFIG, loadConfig as loadErpConfig } from '../../mock-erp/src/config/mock-erp.config.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.factory.js';
import { INTEGRATION_CONFIG, loadConfig } from '../src/config/integration.config.js';
import { DeadLetterHandler } from '../src/dlq/dead-letter.handler.js';
import { EVENT_DISPATCHER } from '../src/ingest/event-dispatcher.js';
import { computeSignature } from '../src/ingest/signature.js';
import { ErpClient } from '../src/erp-client/erp-client.js';
import { NoopSyncMetrics } from '../src/observability/sync-metrics.js';
import { Reconciler } from '../src/reconciliation/reconciler.js';
import { RECONCILIATION_STORE } from '../src/reconciliation/reconciliation-store.js';
import { EnvSecretsProvider } from '../src/secrets/env-secrets.provider.js';
import { SECRETS_PROVIDER } from '../src/secrets/secrets-provider.js';
import { SyncLogService } from '../src/sync-log/sync-log.service.js';
import { invoiceEvent } from '../src/test-support/events.js';
import { SqsBatchHandler } from '../src/worker/sqs-batch-handler.js';
import { SyncWorker } from '../src/worker/sync-worker.js';
import { FakeQueue } from './support/fake-queue.js';

const erpConfig = loadErpConfig({ RATE_LIMIT_PER_SECOND: '0' });
const SECRET = 'test-billing-secret';
const API_KEY = 'test-admin-key';

/**
 * Phase 7, locally: the admin API over HTTP, and the "done when" story:
 * ERP down -> events DEAD -> found via /admin/syncs -> ERP back -> replay -> SUCCEEDED.
 */
describe('Admin API (e2e)', () => {
  let erp: INestApplication;
  let app: INestApplication;
  let queue: FakeQueue;
  let worker: SqsBatchHandler;
  let deadLetters: DeadLetterHandler;
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
          ADMIN_API_KEY: API_KEY,
        }),
      )
      .overrideProvider(EVENT_DISPATCHER)
      .useValue(queue)
      .compile();
    app = appRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    worker = new SqsBatchHandler(app.get(SyncWorker), queue.changeVisibility);
    deadLetters = new DeadLetterHandler(app.get(SyncLogService), new NoopSyncMetrics());

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

  const webhook = (body: unknown) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app.getHttpServer())
      .post('/webhooks/billing')
      .set('Content-Type', 'application/json')
      .set('X-Timestamp', ts)
      .set('X-Signature', computeSignature(SECRET, ts, raw))
      .send(raw);
  };
  const admin = (method: 'get' | 'post', path: string, key: string | null = API_KEY) => {
    const req = request(app.getHttpServer())[method](path);
    return key === null ? req : req.set('X-Api-Key', key);
  };
  const chaos = (errorRate: number) =>
    request(erp.getHttpServer()).put('/mock/chaos').set('Authorization', `Bearer ${erpToken}`).send({ errorRate }).expect(200);

  /** Moves whatever the fake queue sent to its DLQ through the DLQ handler (marks DEAD). */
  async function processDlq() {
    const records = queue.dlq.splice(0).map((body, i) => ({ messageId: `dlq-${i}`, body, attributes: {} }) as SQSRecord);
    await deadLetters.handle(records);
  }

  describe('API key', () => {
    it('401 without a key, 401 with a wrong key', async () => {
      await admin('get', '/admin/stats', null).expect(401);
      await admin('get', '/admin/stats', 'wrong').expect(401);
    });

    it('accepts the right key', async () => {
      await admin('get', '/admin/stats').expect(200);
    });
  });

  describe('dead events, found and replayed', () => {
    const ids = ['evt_dead_1', 'evt_dead_2', 'evt_dead_3'];

    it('ERP down: events are retried 4 times and end DEAD', async () => {
      await chaos(1);
      try {
        for (const [i, id] of ids.entries()) {
          await webhook({ ...invoiceEvent({ invoiceId: `INV-DEAD-${i}` }), id }).expect(202);
        }
        await queue.drain(worker);
      } finally {
        await chaos(0);
      }
      await processDlq();
    });

    it('lists them with status=DEAD, newest first', async () => {
      const res = await admin('get', '/admin/syncs?status=DEAD').expect(200);
      expect(res.body.items.map((i: { eventId: string }) => i.eventId)).toEqual([...ids].reverse());
      expect(res.body.items[0]).toMatchObject({ status: 'DEAD', attempts: 4, flow: 'O2C', businessKey: 'INV-DEAD-2' });
      expect(res.body.items[0]).not.toHaveProperty('payload');
    });

    it('shows one in full: payload, error, history', async () => {
      const res = await admin('get', '/admin/syncs/evt_dead_1').expect(200);
      expect(res.body).toMatchObject({
        status: 'DEAD',
        payload: { id: 'evt_dead_1', type: 'invoice.created' },
        lastError: { code: 'ERP_SERVICE_UNAVAILABLE', class: 'retryable' },
      });
      expect(res.body.history.map((h: { status: string }) => h.status)).toEqual([
        'RECEIVED',
        ...Array.from({ length: 4 }, () => ['PROCESSING', 'RETRYING']).flat(),
        'DEAD',
      ]);
    });

    it('stats count them as dead', async () => {
      const res = await admin('get', '/admin/stats').expect(200);
      expect(res.body.byStatus.DEAD).toBe(3);
      expect(res.body.byFlow.O2C.DEAD).toBe(3);
      expect(res.body.reconciliation).toBeNull();
      expect(res.body).not.toHaveProperty('queues'); // no SQS locally
    });

    it('replay with the ERP back: SUCCEEDED, attempts start again, last error cleared', async () => {
      for (const id of ids) {
        await admin('post', `/admin/syncs/${id}/replay`).expect(202, { syncId: id, status: 'RECEIVED' });
      }
      await queue.drain(worker);

      for (const id of ids) {
        const res = await admin('get', `/admin/syncs/${id}`).expect(200);
        expect(res.body).toMatchObject({ status: 'SUCCEEDED', attempts: 1, erpRecordType: 'invoice' });
        expect(res.body).not.toHaveProperty('lastError');
        expect(res.body.history.slice(-4).map((h: { status: string; note?: string }) => [h.status, h.note])).toEqual([
          ['DEAD', 'DLQ after 4 attempt(s)'],
          ['RECEIVED', 'replayed'],
          ['PROCESSING', undefined],
          ['SUCCEEDED', undefined],
        ]);
      }
      expect((await admin('get', '/admin/syncs?status=DEAD').expect(200)).body.items).toEqual([]);
    });

    it('refuses to replay an event that is not FAILED or DEAD (409), or unknown (404)', async () => {
      const res = await admin('post', '/admin/syncs/evt_dead_1/replay').expect(409);
      expect(res.body.message).toContain('this one is SUCCEEDED');
      await admin('post', '/admin/syncs/evt_nope/replay').expect(404);
    });
  });

  describe('listing', () => {
    it('searches by business key and pages with a cursor', async () => {
      for (let i = 0; i < 3; i++) await webhook({ ...invoiceEvent({ invoiceId: `INV-PAGE-${i}` }), id: `evt_page_${i}` }).expect(202);
      await queue.drain(worker);

      const first = await admin('get', '/admin/syncs?q=inv-page&limit=2').expect(200);
      expect(first.body.items.map((i: { eventId: string }) => i.eventId)).toEqual(['evt_page_2', 'evt_page_1']);
      const second = await admin('get', `/admin/syncs?q=inv-page&limit=2&cursor=${first.body.nextCursor}`).expect(200);
      expect(second.body.items.map((i: { eventId: string }) => i.eventId)).toEqual(['evt_page_0']);
      expect(second.body).not.toHaveProperty('nextCursor');
    });

    it('treats empty form fields as not set, and rejects bad filters', async () => {
      await admin('get', '/admin/syncs?status=&flow=&q=').expect(200);
      await admin('get', '/admin/syncs?status=DONE').expect(400);
      await admin('get', '/admin/syncs?limit=1000').expect(400);
      await admin('get', '/admin/syncs?cursor=garbage').expect(400);
      await admin('get', '/admin/syncs?extra=1').expect(400);
    });

    it('404 for an unknown event', async () => {
      await admin('get', '/admin/syncs/evt_nope').expect(404);
    });
  });

  // Phase 8 "done when": an invoice deleted in the ERP is flagged by the next run.
  describe('reconciliation', () => {
    // Everything above happened seconds ago; a run "10 minutes from now" sees it
    // past the 5-minute settling time.
    const runAt = () => new Date(Date.now() + 10 * 60_000);
    const reconciler = () =>
      new Reconciler(app.get(SyncLogService), app.get(ErpClient), app.get(RECONCILIATION_STORE), new NoopSyncMetrics());

    it('finds nothing when the ERP holds every synced record', async () => {
      const report = await reconciler().run(runAt());
      expect(report.mismatches).toEqual([]);
      // 3 replayed + 3 paged invoices; customers are not compared.
      expect(report.byType.invoice).toEqual({ synced: 6, createdInErp: 6, matched: 6 });
    });

    it('flags an invoice deleted directly in the ERP, and the dashboard stats show it', async () => {
      await request(erp.getHttpServer())
        .delete('/services/rest/record/v1/invoice/eid:INV-PAGE-1')
        .set('Authorization', `Bearer ${erpToken}`)
        .expect(204);

      const report = await reconciler().run(runAt());
      expect(report.mismatches).toEqual([
        expect.objectContaining({ kind: 'MISSING_IN_ERP', recordType: 'invoice', externalId: 'INV-PAGE-1', eventId: 'evt_page_1' }),
      ]);

      const stats = await admin('get', '/admin/stats').expect(200);
      expect(stats.body.reconciliation).toMatchObject({ mismatchCount: 1, mismatches: [{ externalId: 'INV-PAGE-1' }] });
    });
  });
});

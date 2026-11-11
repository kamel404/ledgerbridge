import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { MOCK_ERP_CONFIG, loadConfig } from '../src/config/mock-erp.config.js';

const config = loadConfig({ RATE_LIMIT_PER_SECOND: '0' });
const RECORDS = '/services/rest/record/v1';
const SUITEQL = '/services/rest/query/v1/suiteql';

/**
 * Phase 1 "done when" (SPEC §13, milestone 1):
 * get a token, upsert a customer by external ID twice and see one record,
 * run a SuiteQL SELECT. Plus the main error paths over real HTTP.
 */
describe('Mock ERP (e2e)', () => {
  let app: INestApplication;
  let auth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MOCK_ERP_CONFIG)
      .useValue(config)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/services/rest/auth/oauth2/v1/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret })
      .expect(200);
    auth = { Authorization: `Bearer ${res.body.access_token}` };
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const suiteql = (q: string) => http().post(SUITEQL).set(auth).set('Prefer', 'transient').send({ q });

  describe('authentication', () => {
    it('issues a token with HTTP Basic client credentials too', async () => {
      const res = await http()
        .post('/services/rest/auth/oauth2/v1/token')
        .auth(config.clientId, config.clientSecret)
        .type('form')
        .send({ grant_type: 'client_credentials' })
        .expect(200);
      expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    });

    it('answers a bad secret in OAuth error format', async () => {
      const res = await http()
        .post('/services/rest/auth/oauth2/v1/token')
        .type('form')
        .send({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: 'wrong' })
        .expect(401);
      expect(res.body).toEqual({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    });

    it('returns 401 in NetSuite format without a token', async () => {
      const res = await http().get(`${RECORDS}/customer/1`).expect(401);
      expect(res.body['o:errorDetails'][0]['o:errorCode']).toBe('INVALID_LOGIN');
    });

    it('returns 401 with a garbage token', async () => {
      await http().get(`${RECORDS}/customer/1`).set('Authorization', 'Bearer not-a-jwt').expect(401);
    });

    it('keeps /health public', async () => {
      await http().get('/health').expect(200);
    });
  });

  describe('milestone 1', () => {
    it('upserting a customer twice by external ID leaves one record', async () => {
      const body = { companyName: 'Cedar Logistics SAL', email: 'ap@cedar.example' };
      const first = await http().put(`${RECORDS}/customer/eid:CUS-77`).set(auth).send(body).expect(204);
      const second = await http().put(`${RECORDS}/customer/eid:CUS-77`).set(auth).send(body).expect(204);

      expect(first.headers.location).toMatch(/\/services\/rest\/record\/v1\/customer\/\d+$/);
      // Same record both times. (Compare paths: supertest uses a new port per request.)
      const path = (location?: string) => new URL(location!).pathname;
      expect(path(second.headers.location)).toBe(path(first.headers.location));

      const res = await suiteql("SELECT id, externalId, companyName FROM customer WHERE externalId = 'CUS-77'").expect(200);
      expect(res.body).toMatchObject({ count: 1, totalResults: 1, hasMore: false, offset: 0 });
      expect(res.body.items[0]).toMatchObject({ externalid: 'CUS-77', companyname: 'Cedar Logistics SAL' });
    });

    it('reads the record by internal and by external ID', async () => {
      const byExternal = await http().get(`${RECORDS}/customer/eid:CUS-77`).set(auth).expect(200);
      const byInternal = await http().get(`${RECORDS}/customer/${byExternal.body.id}`).set(auth).expect(200);
      expect(byInternal.body).toMatchObject({ externalId: 'CUS-77', companyName: 'Cedar Logistics SAL' });
    });
  });

  describe('order-to-cash records', () => {
    it('an invoice, then a payment, leaves the invoice paidInFull', async () => {
      await http()
        .put(`${RECORDS}/invoice/eid:INV-1042`)
        .set(auth)
        .send({
          entity: { externalId: 'CUS-77' },
          tranId: 'INV-1042',
          tranDate: '2026-11-11',
          dueDate: '2026-12-11',
          currency: { id: '1' },
          item: { items: [{ item: { id: '501' }, quantity: 3, rate: 49 }] },
        })
        .expect(204);

      await http()
        .put(`${RECORDS}/customerPayment/eid:PAY-5531`)
        .set(auth)
        .send({
          customer: { externalId: 'CUS-77' },
          tranDate: '2026-11-20',
          currency: { id: '1' },
          payment: 147,
          apply: { items: [{ doc: { externalId: 'INV-1042' }, amount: 147 }] },
        })
        .expect(204);

      const res = await http().get(`${RECORDS}/invoice/eid:INV-1042`).set(auth).expect(200);
      expect(res.body).toMatchObject({ total: 147, amountPaid: 147, amountRemaining: 0, status: 'paidInFull' });
      expect(res.body.entity).toMatchObject({ externalId: 'CUS-77', refName: 'Cedar Logistics SAL' });
    });

    it('a reference to a missing customer is a 400 INVALID_REFERENCE in NetSuite format', async () => {
      const res = await http()
        .put(`${RECORDS}/invoice/eid:INV-9`)
        .set(auth)
        .send({
          entity: { externalId: 'CUS-99' },
          tranDate: '2026-11-11',
          currency: { id: '1' },
          item: { items: [{ item: { id: '501' }, quantity: 1, rate: 1 }] },
        })
        .expect(400);
      expect(res.body).toMatchObject({ title: 'Bad Request', status: 400 });
      expect(res.body['o:errorDetails'][0]).toMatchObject({
        'o:errorCode': 'INVALID_REFERENCE',
        detail: expect.stringContaining('Invalid reference: customer CUS-99'),
      });
    });
  });

  describe('record API rules', () => {
    it('POST creates with 204 + Location, and a duplicate externalId is 400', async () => {
      const created = await http().post(`${RECORDS}/vendor`).set(auth).send({ externalId: 'VEN-12', companyName: 'Beirut Office Supplies' }).expect(204);
      expect(created.headers.location).toMatch(/\/vendor\/\d+$/);
      const dup = await http().post(`${RECORDS}/vendor`).set(auth).send({ externalId: 'VEN-12', companyName: 'Again' }).expect(400);
      expect(dup.body['o:errorDetails'][0]['o:errorCode']).toBe('DUPLICATE_EXTERNAL_ID');
    });

    it('PATCH updates, DELETE removes, then GET is 404', async () => {
      const created = await http().post(`${RECORDS}/vendor`).set(auth).send({ companyName: 'Temp' }).expect(204);
      const path = new URL(created.headers.location!).pathname;
      await http().patch(path).set(auth).send({ phone: '123' }).expect(204);
      expect((await http().get(path).set(auth).expect(200)).body).toMatchObject({ companyName: 'Temp', phone: '123' });
      await http().delete(path).set(auth).expect(204);
      await http().get(path).set(auth).expect(404);
    });

    it('PUT with an internal ID is rejected', async () => {
      await http().put(`${RECORDS}/vendor/1`).set(auth).send({ companyName: 'X' }).expect(400);
    });

    it('an unknown record type is 404', async () => {
      const res = await http().get(`${RECORDS}/salesOrder/1`).set(auth).expect(404);
      expect(res.body['o:errorDetails'][0]['o:errorCode']).toBe('RECORD_TYPE_NOT_FOUND');
    });

    it('record types are case-insensitive', async () => {
      await http().get(`${RECORDS}/CUSTOMER/eid:CUS-77`).set(auth).expect(200);
    });
  });

  describe('SuiteQL', () => {
    it('supports WHERE, ORDER BY, limit and offset', async () => {
      for (const n of [1, 2, 3]) {
        await http().put(`${RECORDS}/customer/eid:PAGE-${n}`).set(auth).send({ companyName: `Page ${n}` }).expect(204);
      }
      const res = await http()
        .post(`${SUITEQL}?limit=2&offset=0`)
        .set(auth)
        .set('Prefer', 'transient')
        .send({ q: "SELECT externalId FROM customer WHERE companyName >= 'Page' ORDER BY companyName DESC" })
        .expect(200);
      expect(res.body).toMatchObject({ count: 2, totalResults: 3, hasMore: true });
      expect(res.body.items.map((i: { externalid: string }) => i.externalid)).toEqual(['PAGE-3', 'PAGE-2']);
    });

    it('rejects unsupported SQL with 400 INVALID_SUITEQL', async () => {
      const res = await suiteql('DELETE FROM customer').expect(400);
      expect(res.body['o:errorDetails'][0]['o:errorCode']).toBe('INVALID_SUITEQL');
    });

    it('rejects an unknown column', async () => {
      const res = await suiteql('SELECT password FROM customer').expect(400);
      expect(res.body['o:errorDetails'][0].detail).toContain("Unknown column 'password'");
    });

    it('requires the Prefer: transient header', async () => {
      await http().post(SUITEQL).set(auth).send({ q: 'SELECT * FROM customer' }).expect(400);
    });
  });

  describe('chaos', () => {
    afterEach(async () => {
      await http().put('/mock/chaos').set(auth).send({ errorRate: 0 }).expect(200);
    });

    it('errorRate 1 makes ERP calls fail with 503, but /mock/chaos still works', async () => {
      await http().put('/mock/chaos').set(auth).send({ errorRate: 1 }).expect(200);
      const res = await http().get(`${RECORDS}/customer/eid:CUS-77`).set(auth).expect(503);
      expect(res.body['o:errorDetails'][0]['o:errorCode']).toBe('SERVICE_UNAVAILABLE');
      expect((await http().get('/mock/chaos').set(auth).expect(200)).body.errorRate).toBe(1);
    });

    it('rejects invalid chaos settings', async () => {
      await http().put('/mock/chaos').set(auth).send({ errorRate: 2 }).expect(400);
    });
  });
});

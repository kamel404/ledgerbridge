import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule as MockErpModule } from '../../mock-erp/src/app.module.js';
import { MOCK_ERP_CONFIG, loadConfig as loadErpConfig } from '../../mock-erp/src/config/mock-erp.config.js';
import { loadConfig } from '../src/config/integration.config.js';
import { ErpClient, type ErpRecordType } from '../src/erp-client/erp-client.js';
import { PermanentError, RetryableError } from '../src/errors/integration-errors.js';
import { InvoiceCreatedHandler } from '../src/flows/o2c/invoice-created.handler.js';
import { PaymentReceivedHandler } from '../src/flows/o2c/payment-received.handler.js';
import { BillApprovedHandler } from '../src/flows/p2p/bill-approved.handler.js';
import { RECONCILED_TYPES } from '../src/reconciliation/reconciliation-report.js';
import { EnvSecretsProvider } from '../src/secrets/env-secrets.provider.js';
import { billEvent, invoiceEvent, paymentEvent } from '../src/test-support/events.js';

/**
 * Contract test (PLAN Phase 8): the real ErpClient, the real mappers and the
 * real mock ERP, over HTTP. Unit tests fake one side each; this checks the two
 * sides still agree:
 *
 * - every path, method and header the client sends matches a mock route,
 * - every body the mappers build passes the mock's (strict) record schemas,
 * - the response fields our code reads (Location, entity, currency,
 *   amountRemaining, SuiteQL column names, paging) are the ones the mock sends,
 * - error responses become the right RetryableError / PermanentError.
 *
 * If this fails after a change to either app, the change broke the contract.
 */

async function startMockErp(env: Record<string, string> = {}) {
  const config = loadErpConfig({ RATE_LIMIT_PER_SECOND: '0', ...env });
  const ref = await Test.createTestingModule({ imports: [MockErpModule] })
    .overrideProvider(MOCK_ERP_CONFIG)
    .useValue(config)
    .compile();
  const app = ref.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const client = new ErpClient(
    loadConfig({ ERP_BASE_URL: url }),
    new EnvSecretsProvider({ MOCK_ERP_CLIENT_ID: config.clientId, MOCK_ERP_CLIENT_SECRET: config.clientSecret }),
    (...args) => fetch(...args),
  );
  return { app, client };
}

describe('ERP client <-> mock ERP contract', () => {
  let erp: INestApplication;
  let client: ErpClient;

  beforeAll(async () => {
    ({ app: erp, client } = await startMockErp());
  });
  afterAll(async () => {
    await erp?.close();
  });

  describe('writes: every mapper body is accepted, upserts are idempotent', () => {
    it('invoice.created: customer + invoice', async () => {
      const result = await new InvoiceCreatedHandler(client).handle(invoiceEvent());
      expect(result).toEqual({ erpRecordType: 'invoice', erpRecordId: expect.stringMatching(/^\d+$/) });

      // Same event again: same internal ID (the upsert found the record by external ID).
      const again = await new InvoiceCreatedHandler(client).handle(invoiceEvent());
      expect(again.erpRecordId).toBe(result.erpRecordId);
    });

    it('payment.received: the invoice fields the payment rules read are there', async () => {
      const invoice = await client.getByExternalId('invoice', 'INV-1042');
      // checkPaymentRules reads exactly these:
      expect(invoice).toMatchObject({
        entity: { externalId: 'CUS-77' },
        currency: { id: '1' },
        amountRemaining: 147,
      });

      const result = await new PaymentReceivedHandler(client).handle(paymentEvent());
      expect(result.erpRecordType).toBe('customerPayment');
      expect(await client.getByExternalId('invoice', 'INV-1042')).toMatchObject({ amountRemaining: 0 });

      // Processed again (e.g. a retry after a lost reply): still accepted, still one payment.
      const again = await new PaymentReceivedHandler(client).handle(paymentEvent());
      expect(again.erpRecordId).toBe(result.erpRecordId);
    });

    it('bill.approved: vendor + vendor bill', async () => {
      const result = await new BillApprovedHandler(client).handle(billEvent());
      expect(result).toEqual({ erpRecordType: 'vendorBill', erpRecordId: expect.stringMatching(/^\d+$/) });
      expect(await client.getByExternalId('vendor', 'VEN-12')).toMatchObject({ externalId: 'VEN-12' });
    });
  });

  describe('reads', () => {
    it('a missing record is undefined, not an error', async () => {
      for (const type of ['customer', 'vendor', 'invoice', 'customerPayment', 'vendorBill'] satisfies ErpRecordType[]) {
        expect(await client.getByExternalId(type, 'DOES-NOT-EXIST')).toBeUndefined();
      }
    });

    it('external IDs with characters that need escaping work', async () => {
      const event = invoiceEvent({ invoiceId: 'INV/2026 #7' });
      const { erpRecordId } = await new InvoiceCreatedHandler(client).handle(event);
      expect(await client.getByExternalId('invoice', 'INV/2026 #7')).toMatchObject({ id: erpRecordId });
    });

    it("the reconciler's SuiteQL query works on every reconciled type, with the column names it reads", async () => {
      for (const type of RECONCILED_TYPES) {
        const page = await client.suiteql<Record<string, unknown>>(
          `SELECT id, externalid, createddate FROM ${type} WHERE lastmodifieddate >= '2000-01-01T00:00:00.000Z'`,
          { limit: 1000, offset: 0 },
        );
        expect(page.items.length).toBeGreaterThan(0);
        expect(Object.keys(page.items[0]!).sort()).toEqual(['createddate', 'externalid', 'id']);
      }
    });

    it('SuiteQL pages with limit/offset/hasMore', async () => {
      const q = "SELECT id FROM invoice WHERE lastmodifieddate >= '2000-01-01T00:00:00.000Z'";
      const first = await client.suiteql(q, { limit: 1, offset: 0 });
      expect(first).toMatchObject({ count: 1, offset: 0, totalResults: 2, hasMore: true });
      const second = await client.suiteql(q, { limit: 1, offset: 1 });
      expect(second).toMatchObject({ count: 1, offset: 1, hasMore: false });
      expect(second.items[0]).not.toEqual(first.items[0]);
    });
  });

  describe('errors become the right class', () => {
    it('data the ERP rejects is permanent, with the NetSuite code in ours', async () => {
      // A payment applied to an invoice that doesn't exist.
      const err = await client
        .upsert('customerPayment', 'PAY-BAD', {
          customer: { externalId: 'CUS-77' },
          tranDate: '2026-11-20',
          currency: { id: '1' },
          payment: 1,
          apply: { items: [{ doc: { id: '999999' }, amount: 1 }] },
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect((err as PermanentError).code).toMatch(/^ERP_[A-Z_]+$/);
    });

    it('a field the mock does not know is permanent (its schemas are strict, like NetSuite)', async () => {
      const err = await client.upsert('vendor', 'VEN-X', { companyName: 'X', favouriteColour: 'blue' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentError);
    });

    it('invalid SuiteQL is permanent', async () => {
      const err = await client.suiteql('SELECT id FROM invoice WHERE a = 1 OR b = 2').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentError);
      expect((err as PermanentError).code).toBe('ERP_INVALID_SUITEQL');
    });
  });

  it('rate limiting (429 + Retry-After) is retryable and carries the wait', async () => {
    const limited = await startMockErp({ RATE_LIMIT_PER_SECOND: '1' });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => limited.client.getByExternalId('invoice', 'X')),
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected[0]).toBeInstanceOf(RetryableError);
      expect(rejected[0]).toMatchObject({ code: 'ERP_RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
    } finally {
      await limited.app.close();
    }
  });
});

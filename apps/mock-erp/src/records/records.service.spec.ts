import { NetSuiteError } from '../common/netsuite-error.js';
import { InMemoryRecordStore } from './in-memory-record-store.js';
import { RecordsService } from './records.service.js';

const customerBody = { companyName: 'Cedar Logistics SAL', email: 'ap@cedar.example' };

const invoiceBody = (overrides: Record<string, unknown> = {}) => ({
  entity: { externalId: 'CUS-77' },
  tranId: 'INV-1042',
  tranDate: '2026-11-11',
  currency: { id: '1' },
  item: { items: [{ item: { id: '501' }, quantity: 3, rate: 49 }] },
  ...overrides,
});

const paymentBody = (amount: number, overrides: Record<string, unknown> = {}) => ({
  customer: { externalId: 'CUS-77' },
  tranDate: '2026-11-20',
  currency: { id: '1' },
  payment: amount,
  apply: { items: [{ doc: { externalId: 'INV-1042' }, amount }] },
  ...overrides,
});

/** Runs `fn` and returns the NetSuiteError it throws. */
async function errorOf(fn: () => Promise<unknown>): Promise<NetSuiteError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof NetSuiteError) return err;
    throw err;
  }
  throw new Error('Expected a NetSuiteError, but nothing was thrown');
}

describe('RecordsService', () => {
  let store: InMemoryRecordStore;
  let service: RecordsService;

  beforeEach(() => {
    store = new InMemoryRecordStore();
    service = new RecordsService(store);
  });

  describe('upsert by external ID', () => {
    it('creates once, then updates the same record', async () => {
      const first = await service.upsert('customer', 'CUS-77', customerBody);
      const second = await service.upsert('customer', 'CUS-77', { ...customerBody, phone: '+961 1 000000' });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.record.id).toBe(first.record.id);
      expect(await store.list('customer')).toHaveLength(1);
      expect(second.record.fields).toMatchObject({ companyName: 'Cedar Logistics SAL', phone: '+961 1 000000' });
    });

    it('keeps one record when the same upsert runs concurrently', async () => {
      await Promise.all([1, 2, 3, 4, 5].map(() => service.upsert('customer', 'CUS-77', customerBody)));
      expect(await store.list('customer')).toHaveLength(1);
    });

    it('rejects a body externalId that differs from the URL', async () => {
      const err = await errorOf(() => service.upsert('customer', 'CUS-77', { ...customerBody, externalId: 'CUS-1' }));
      expect(err.code).toBe('INVALID_CONTENT');
    });
  });

  describe('create', () => {
    it('assigns sequential internal IDs per record type', async () => {
      const a = await service.create('customer', { companyName: 'A' });
      const b = await service.create('customer', { companyName: 'B' });
      const v = await service.create('vendor', { companyName: 'V' });
      expect([a.id, b.id, v.id]).toEqual(['1', '2', '1']);
    });

    it('rejects a duplicate externalId with 400', async () => {
      await service.create('customer', { ...customerBody, externalId: 'CUS-77' });
      const err = await errorOf(() => service.create('customer', { ...customerBody, externalId: 'CUS-77' }));
      expect(err.status).toBe(400);
      expect(err.code).toBe('DUPLICATE_EXTERNAL_ID');
    });

    it('rejects unknown fields and missing required fields, naming them', async () => {
      const unknown = await errorOf(() => service.create('customer', { companyName: 'A', colour: 'red' }));
      expect(unknown.code).toBe('INVALID_CONTENT');
      expect(unknown.detail).toContain('colour');

      const missing = await errorOf(() => service.create('customer', { email: 'a@b.example' }));
      expect(missing.detail).toContain('companyName');
    });

    it('rejects a body that is not an object', async () => {
      const err = await errorOf(() => service.create('customer', ['not', 'an', 'object']));
      expect(err.code).toBe('INVALID_CONTENT');
    });
  });

  describe('references', () => {
    beforeEach(async () => {
      await service.upsert('customer', 'CUS-77', customerBody);
    });

    it('resolves a reference by external ID and stores id + refName', async () => {
      const { record } = await service.upsert('invoice', 'INV-1042', invoiceBody());
      expect(record.fields.entity).toEqual({ id: '1', externalId: 'CUS-77', refName: 'Cedar Logistics SAL' });
    });

    it('resolves a reference by internal ID', async () => {
      const { record } = await service.upsert('invoice', 'INV-1042', invoiceBody({ entity: { id: '1' } }));
      expect((record.fields.entity as { externalId: string }).externalId).toBe('CUS-77');
    });

    it('rejects a reference to a missing record with the SPEC message', async () => {
      const err = await errorOf(() =>
        service.upsert('invoice', 'INV-1', invoiceBody({ entity: { externalId: 'CUS-99' } })),
      );
      expect(err.code).toBe('INVALID_REFERENCE');
      expect(err.detail).toContain('Invalid reference: customer CUS-99');
    });

    it('rejects an invoice with no lines', async () => {
      const err = await errorOf(() => service.upsert('invoice', 'INV-1', invoiceBody({ item: { items: [] } })));
      expect(err.code).toBe('INVALID_CONTENT');
    });
  });

  describe('invoice amounts and payments', () => {
    beforeEach(async () => {
      await service.upsert('customer', 'CUS-77', customerBody);
      await service.upsert('invoice', 'INV-1042', invoiceBody());
    });

    const invoice = () => service.getByExternalId('invoice', 'INV-1042');

    it('computes the total and starts open', async () => {
      expect((await invoice()).computed).toEqual({
        total: 147,
        amountPaid: 0,
        amountRemaining: 147,
        status: 'open',
      });
    });

    it('a partial payment reduces the remaining amount', async () => {
      await service.upsert('customerPayment', 'PAY-1', paymentBody(47));
      expect((await invoice()).computed).toMatchObject({ amountPaid: 47, amountRemaining: 100, status: 'open' });
    });

    it('a full payment marks the invoice paidInFull', async () => {
      await service.upsert('customerPayment', 'PAY-5531', paymentBody(147));
      expect((await invoice()).computed).toMatchObject({ amountPaid: 147, amountRemaining: 0, status: 'paidInFull' });
    });

    it('upserting the same payment twice counts it once', async () => {
      await service.upsert('customerPayment', 'PAY-5531', paymentBody(100));
      await service.upsert('customerPayment', 'PAY-5531', paymentBody(100));
      expect((await invoice()).computed).toMatchObject({ amountPaid: 100, amountRemaining: 47 });
    });

    it('changing a payment amount moves the difference', async () => {
      await service.upsert('customerPayment', 'PAY-1', paymentBody(100));
      await service.upsert('customerPayment', 'PAY-1', paymentBody(40));
      expect((await invoice()).computed).toMatchObject({ amountPaid: 40, amountRemaining: 107 });
    });

    it('deleting a payment gives its amount back', async () => {
      await service.upsert('customerPayment', 'PAY-1', paymentBody(147));
      const payment = await service.getByExternalId('customerPayment', 'PAY-1');
      await service.delete('customerPayment', payment.id);
      expect((await invoice()).computed).toMatchObject({ amountPaid: 0, status: 'open' });
    });

    it('rejects a payment larger than the remaining balance', async () => {
      await service.upsert('customerPayment', 'PAY-1', paymentBody(100));
      const err = await errorOf(() => service.upsert('customerPayment', 'PAY-2', paymentBody(50)));
      expect(err.code).toBe('INVALID_AMOUNT');
      expect(err.detail).toContain('remaining balance 47');
      expect((await invoice()).computed).toMatchObject({ amountPaid: 100 });
    });

    it('rejects a payment in a different currency', async () => {
      const err = await errorOf(() =>
        service.upsert('customerPayment', 'PAY-1', paymentBody(10, { currency: { id: '2' } })),
      );
      expect(err.detail).toContain('does not match invoice INV-1042 currency');
    });

    it('rejects a payment from a different customer', async () => {
      await service.upsert('customer', 'CUS-1', { companyName: 'Other' });
      const err = await errorOf(() =>
        service.upsert('customerPayment', 'PAY-1', paymentBody(10, { customer: { externalId: 'CUS-1' } })),
      );
      expect(err.code).toBe('INVALID_REFERENCE');
    });

    it('rejects applying more than the payment amount', async () => {
      const body = paymentBody(10);
      body.payment = 5;
      const err = await errorOf(() => service.upsert('customerPayment', 'PAY-1', body));
      expect(err.detail).toContain('exceeds the payment amount');
    });

    it('rejects lowering an invoice total below what was already paid', async () => {
      await service.upsert('customerPayment', 'PAY-1', paymentBody(147));
      const err = await errorOf(() =>
        service.upsert('invoice', 'INV-1042', invoiceBody({ item: { items: [{ item: { id: '501' }, quantity: 1, rate: 49 }] } })),
      );
      expect(err.code).toBe('INVALID_AMOUNT');
    });
  });

  describe('vendor bills', () => {
    it('computes the total from expense lines', async () => {
      await service.upsert('vendor', 'VEN-12', { companyName: 'Beirut Office Supplies' });
      const { record } = await service.upsert('vendorBill', 'BILL-2209', {
        entity: { externalId: 'VEN-12' },
        tranId: 'BILL-2209',
        tranDate: '2026-11-10',
        currency: { id: '1' },
        expense: {
          items: [
            { account: { id: '6100' }, amount: 240, memo: 'Printer paper' },
            { account: { id: '6100' }, amount: 10.1 },
          ],
        },
      });
      expect(record.computed).toEqual({ total: 250.1 });
    });
  });

  describe('patch and delete', () => {
    it('patch changes only the fields sent', async () => {
      const { record } = await service.upsert('customer', 'CUS-77', customerBody);
      const patched = await service.patch('customer', record.id, { phone: '123' });
      expect(patched.fields).toMatchObject({ companyName: 'Cedar Logistics SAL', email: 'ap@cedar.example', phone: '123' });
    });

    it('delete removes the record and frees its external ID', async () => {
      const { record } = await service.upsert('customer', 'CUS-77', customerBody);
      await service.delete('customer', record.id);
      expect((await errorOf(() => service.getById('customer', record.id))).status).toBe(404);
      expect((await service.upsert('customer', 'CUS-77', customerBody)).created).toBe(true);
    });
  });
});

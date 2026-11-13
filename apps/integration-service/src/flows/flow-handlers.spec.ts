import type { ErpClient, ErpRecord, ErpRecordType } from '../erp-client/erp-client.js';
import { PermanentError, RetryableError } from '../errors/integration-errors.js';
import { billEvent, invoiceEvent, paymentEvent } from '../test-support/events.js';
import { businessKeyOf, type FlowHandler } from './flow-handler.js';
import { FlowRegistry } from './flow-registry.js';
import { InvoiceCreatedHandler } from './o2c/invoice-created.handler.js';
import { PaymentReceivedHandler } from './o2c/payment-received.handler.js';
import { BillApprovedHandler } from './p2p/bill-approved.handler.js';

/**
 * A fake ERP client: records every upsert in order, hands out internal IDs
 * 1, 2, 3, ... per new external ID, and answers lookups from what it holds.
 */
function fakeErp(seed: Array<{ type: ErpRecordType; record: ErpRecord }> = []) {
  const records = new Map<string, ErpRecord>(seed.map((s) => [`${s.type}:${s.record.externalId}`, s.record]));
  const upserts: Array<{ type: ErpRecordType; externalId: string; body: Record<string, unknown> }> = [];
  let nextId = 1;
  const erp = {
    upsert: vi.fn(async (type: ErpRecordType, externalId: string, body: Record<string, unknown>) => {
      upserts.push({ type, externalId, body });
      const key = `${type}:${externalId}`;
      const id = records.get(key)?.id ?? String(nextId++);
      records.set(key, { id, externalId, ...body });
      return { id };
    }),
    getByExternalId: vi.fn(async (type: ErpRecordType, externalId: string) => records.get(`${type}:${externalId}`)),
  };
  return { erp: erp as unknown as ErpClient, upserts, mock: erp };
}

/** An invoice as the ERP returns it: customer CUS-77, USD, 147 left to pay. */
const erpInvoice = (changes: Partial<ErpRecord> = {}): ErpRecord => ({
  id: '42',
  externalId: 'INV-1042',
  entity: { id: '7', externalId: 'CUS-77' },
  currency: { id: '1' },
  amountRemaining: 147,
  ...changes,
});

describe('InvoiceCreatedHandler', () => {
  it('upserts the customer, then the invoice, and returns the invoice', async () => {
    const { erp, upserts } = fakeErp();
    const result = await new InvoiceCreatedHandler(erp).handle(invoiceEvent());

    expect(upserts.map((u) => `${u.type}:${u.externalId}`)).toEqual(['customer:CUS-77', 'invoice:INV-1042']);
    expect(upserts[1]!.body).toMatchObject({ entity: { externalId: 'CUS-77' } });
    expect(result).toEqual({ erpRecordType: 'invoice', erpRecordId: '2' });
  });

  it('writes nothing when a line has an unknown SKU', async () => {
    const { erp, upserts } = fakeErp();
    const event = invoiceEvent({ lines: [{ sku: 'NOPE', description: 'x', quantity: 1, unitPrice: 1 }] });

    await expect(new InvoiceCreatedHandler(erp).handle(event)).rejects.toMatchObject({ code: 'UNKNOWN_SKU' });
    expect(upserts).toEqual([]);
  });

  it('passes ERP errors through (e.g. the ERP is down)', async () => {
    const { erp, mock } = fakeErp();
    mock.upsert.mockRejectedValueOnce(new RetryableError('ERP_SERVICE_UNAVAILABLE', 'down'));
    await expect(new InvoiceCreatedHandler(erp).handle(invoiceEvent())).rejects.toBeInstanceOf(RetryableError);
  });
});

describe('PaymentReceivedHandler', () => {
  it('applies the payment to the invoice it found by external ID', async () => {
    const { erp, upserts } = fakeErp([{ type: 'invoice', record: erpInvoice() }]);
    const result = await new PaymentReceivedHandler(erp).handle(paymentEvent());

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      type: 'customerPayment',
      externalId: 'PAY-5531',
      body: { payment: 147, apply: { items: [{ doc: { id: '42' }, amount: 147 }] } },
    });
    expect(result).toEqual({ erpRecordType: 'customerPayment', erpRecordId: '1' });
  });

  it('retries later when the invoice is not in the ERP yet (out of order)', async () => {
    const { erp, upserts } = fakeErp();
    const err = await new PaymentReceivedHandler(erp).handle(paymentEvent()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetryableError);
    expect(err).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(upserts).toEqual([]);
  });

  it('fails for good when the payment is larger than what is left to pay', async () => {
    const { erp, upserts } = fakeErp([{ type: 'invoice', record: erpInvoice({ amountRemaining: 100 }) }]);
    const err = await new PaymentReceivedHandler(erp).handle(paymentEvent()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PermanentError);
    expect(err).toMatchObject({ code: 'PAYMENT_EXCEEDS_BALANCE' });
    expect(upserts).toEqual([]);
  });

  it('processing the same payment again is not an overpayment (its earlier amount is added back)', async () => {
    const paid = erpInvoice({ amountRemaining: 0 });
    const existing: ErpRecord = { id: '9', externalId: 'PAY-5531', apply: { items: [{ doc: { id: '42' }, amount: 147 }] } };
    const { erp, upserts } = fakeErp([
      { type: 'invoice', record: paid },
      { type: 'customerPayment', record: existing },
    ]);

    const result = await new PaymentReceivedHandler(erp).handle(paymentEvent());

    expect(result).toEqual({ erpRecordType: 'customerPayment', erpRecordId: '9' });
    expect(upserts).toHaveLength(1);
  });
});

describe('BillApprovedHandler', () => {
  it('upserts the vendor, then the vendor bill, and returns the bill', async () => {
    const { erp, upserts } = fakeErp();
    const result = await new BillApprovedHandler(erp).handle(billEvent());

    expect(upserts.map((u) => `${u.type}:${u.externalId}`)).toEqual(['vendor:VEN-12', 'vendorBill:BILL-2209']);
    expect(result).toEqual({ erpRecordType: 'vendorBill', erpRecordId: '2' });
  });

  it('writes nothing when a line has an unknown expense category', async () => {
    const { erp, upserts } = fakeErp();
    const event = billEvent({ lines: [{ expenseCategory: 'NOPE', description: 'x', amount: 1 }] });

    await expect(new BillApprovedHandler(erp).handle(event)).rejects.toBeInstanceOf(PermanentError);
    expect(upserts).toEqual([]);
  });
});

describe('FlowRegistry', () => {
  const handler = (eventType: string, handle = vi.fn(async () => ({ erpRecordType: 'invoice' as const, erpRecordId: '1' }))) =>
    ({ eventType, handle }) as unknown as FlowHandler;

  it('runs the handler for the event type', async () => {
    const invoices = handler('invoice.created');
    const registry = new FlowRegistry([invoices, handler('payment.received')]);

    expect(registry.supports('invoice.created')).toBe(true);
    expect(registry.supports('order.shipped')).toBe(false);
    await expect(registry.processEvent(invoiceEvent())).resolves.toEqual({ erpRecordType: 'invoice', erpRecordId: '1' });
    expect(invoices.handle).toHaveBeenCalledOnce();
  });

  it('refuses an event type nobody handles, for good (retrying cannot help)', async () => {
    const registry = new FlowRegistry([handler('invoice.created')]);
    await expect(registry.processEvent(billEvent())).rejects.toMatchObject({ code: 'UNSUPPORTED_EVENT_TYPE', errorClass: 'permanent' });
  });

  it('refuses two handlers for the same event type at start-up', () => {
    expect(() => new FlowRegistry([handler('invoice.created'), handler('invoice.created')])).toThrow(
      'Two flow handlers registered for invoice.created',
    );
  });
});

describe('businessKeyOf', () => {
  it('is the invoice ID, payment ID or bill number', () => {
    expect(businessKeyOf(invoiceEvent())).toBe('INV-1042');
    expect(businessKeyOf(paymentEvent())).toBe('PAY-5531');
    expect(businessKeyOf(billEvent())).toBe('BILL-2209');
  });
});

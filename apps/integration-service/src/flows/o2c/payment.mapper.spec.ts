import type { ErpRecord } from '../../erp-client/erp-client.js';
import { paymentEvent } from '../../test-support/events.js';
import { checkPaymentRules, mapPayment } from './payment.mapper.js';

/** The invoice as the mock ERP returns it after the SPEC §6.1 invoice was synced. */
function erpInvoice(changes: Partial<ErpRecord> = {}): ErpRecord {
  return {
    id: '42',
    externalId: 'INV-1042',
    entity: { id: '7', externalId: 'CUS-77', refName: 'Cedar Logistics SAL' },
    currency: { id: '1' },
    total: 147,
    amountPaid: 0,
    amountRemaining: 147,
    status: 'open',
    ...changes,
  };
}

describe('payment mapper', () => {
  it('maps a payment applied to the invoice', () => {
    expect(mapPayment(paymentEvent(), '42')).toEqual({
      customer: { externalId: 'CUS-77' },
      tranDate: '2026-11-20',
      currency: { id: '1' },
      payment: 147,
      paymentMethod: 'bank_transfer',
      apply: { items: [{ doc: { id: '42' }, amount: 147 }] },
    });
  });
});

describe('payment rules', () => {
  it('accepts a full payment', () => {
    expect(() => checkPaymentRules(paymentEvent(), erpInvoice())).not.toThrow();
  });

  it('accepts a partial payment', () => {
    expect(() => checkPaymentRules(paymentEvent({ amount: 50 }), erpInvoice())).not.toThrow();
  });

  it('refuses more than the remaining balance (permanent)', () => {
    const invoice = erpInvoice({ amountPaid: 100, amountRemaining: 47 });
    expect(() => checkPaymentRules(paymentEvent({ amount: 47.01 }), invoice)).toThrow(
      expect.objectContaining({ code: 'PAYMENT_EXCEEDS_BALANCE', errorClass: 'permanent' }),
    );
  });

  it('compares money in cents, not floats', () => {
    const invoice = erpInvoice({ amountRemaining: 0.3 });
    expect(() => checkPaymentRules(paymentEvent({ amount: 0.1 + 0.2 }), invoice)).not.toThrow();
  });

  it('refuses a currency different from the invoice (permanent)', () => {
    expect(() => checkPaymentRules(paymentEvent({ currency: 'EUR' }), erpInvoice())).toThrow(
      expect.objectContaining({ code: 'PAYMENT_CURRENCY_MISMATCH', errorClass: 'permanent' }),
    );
  });

  it('refuses a payment from another customer (permanent)', () => {
    expect(() => checkPaymentRules(paymentEvent({ customerId: 'CUS-99' }), erpInvoice())).toThrow(
      expect.objectContaining({ code: 'PAYMENT_CUSTOMER_MISMATCH', errorClass: 'permanent' }),
    );
  });

  it('allows re-processing a payment that is already applied (idempotent retry)', () => {
    const paidInvoice = erpInvoice({ amountPaid: 147, amountRemaining: 0, status: 'paidInFull' });
    const samePayment: ErpRecord = {
      id: '9',
      externalId: 'PAY-5531',
      apply: { items: [{ doc: { id: '42', externalId: 'INV-1042' }, amount: 147 }] },
    };
    expect(() => checkPaymentRules(paymentEvent(), paidInvoice, samePayment)).not.toThrow();
    // Without knowing it's the same payment, it would look like an overpayment.
    expect(() => checkPaymentRules(paymentEvent(), paidInvoice)).toThrow(
      expect.objectContaining({ code: 'PAYMENT_EXCEEDS_BALANCE' }),
    );
  });
});

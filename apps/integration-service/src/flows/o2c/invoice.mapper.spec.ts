import { PermanentError } from '../../errors/integration-errors.js';
import { invoiceEvent } from '../../test-support/events.js';
import { mapCustomer, mapInvoice } from './invoice.mapper.js';

describe('invoice mapper', () => {
  it('maps the SPEC §6.1 example to an ERP invoice', () => {
    expect(mapInvoice(invoiceEvent())).toEqual({
      tranId: 'INV-1042',
      entity: { externalId: 'CUS-77' },
      tranDate: '2026-11-11',
      dueDate: '2026-12-11',
      currency: { id: '1' },
      item: {
        items: [{ item: { id: '501' }, description: 'Pro plan, monthly', quantity: 3, rate: 49 }],
      },
    });
  });

  it('maps the customer', () => {
    expect(mapCustomer(invoiceEvent())).toEqual({ companyName: 'Cedar Logistics SAL', email: 'ap@cedar.example' });
  });

  it('leaves out optional fields that are missing', () => {
    const event = invoiceEvent({
      dueDate: undefined,
      customer: { id: 'CUS-1', name: 'No Email Ltd' },
      lines: [{ sku: 'PLAN-STARTER', quantity: 1, unitPrice: 19 }],
    });
    const invoice = mapInvoice(event);
    expect(invoice).not.toHaveProperty('dueDate');
    expect(invoice.item).toEqual({ items: [{ item: { id: '500' }, quantity: 1, rate: 19 }] });
    expect(mapCustomer(event)).toEqual({ companyName: 'No Email Ltd' });
  });

  it('keeps a zero-price line (free add-on)', () => {
    const invoice = mapInvoice(invoiceEvent({ lines: [{ sku: 'ADDON-SEATS', quantity: 2, unitPrice: 0 }] }));
    expect(invoice.item).toEqual({ items: [{ item: { id: '510' }, quantity: 2, rate: 0 }] });
  });

  it('refuses a zero-line invoice as a permanent error', () => {
    expect(() => mapInvoice(invoiceEvent({ lines: [] }))).toThrow(
      expect.objectContaining({ code: 'EMPTY_INVOICE', errorClass: 'permanent' }),
    );
  });

  it('refuses an unknown SKU as a permanent error', () => {
    const event = invoiceEvent({ lines: [{ sku: 'PLAN-GOLD', quantity: 1, unitPrice: 10 }] });
    expect(() => mapInvoice(event)).toThrow(PermanentError);
    expect(() => mapInvoice(event)).toThrow(expect.objectContaining({ code: 'UNKNOWN_SKU' }));
  });

  it('refuses an unknown currency as a permanent error', () => {
    expect(() => mapInvoice(invoiceEvent({ currency: 'JPY' }))).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_CURRENCY', errorClass: 'permanent' }),
    );
  });

  it('does not trip over inherited object keys as SKUs', () => {
    const event = invoiceEvent({ lines: [{ sku: 'toString', quantity: 1, unitPrice: 1 }] });
    expect(() => mapInvoice(event)).toThrow(expect.objectContaining({ code: 'UNKNOWN_SKU' }));
  });
});

import { EVENT_FLOW, parseEvent, type LedgerEvent } from './events.js';

// Samples copied from SPEC §6.
const invoiceCreated = {
  id: 'evt_01HZX',
  type: 'invoice.created',
  occurredAt: '2026-11-11T09:30:00Z',
  data: {
    invoiceId: 'INV-1042',
    customer: { id: 'CUS-77', name: 'Cedar Logistics SAL', email: 'ap@cedar.example' },
    issueDate: '2026-11-11',
    dueDate: '2026-12-11',
    currency: 'USD',
    lines: [{ sku: 'PLAN-PRO', description: 'Pro plan, monthly', quantity: 3, unitPrice: 49.0 }],
  },
};

const paymentReceived = {
  id: 'evt_01HZY',
  type: 'payment.received',
  occurredAt: '2026-11-20T14:02:00Z',
  data: {
    paymentId: 'PAY-5531',
    invoiceId: 'INV-1042',
    customerId: 'CUS-77',
    amount: 147.0,
    currency: 'USD',
    method: 'bank_transfer',
    receivedDate: '2026-11-20',
  },
};

const billApproved = {
  id: 'evt_01J0A',
  type: 'bill.approved',
  occurredAt: '2026-11-11T11:00:00Z',
  data: {
    billNumber: 'BILL-2209',
    vendor: { id: 'VEN-12', name: 'Beirut Office Supplies' },
    billDate: '2026-11-10',
    dueDate: '2026-12-10',
    currency: 'USD',
    lines: [{ expenseCategory: 'OFFICE_SUPPLIES', description: 'Printer paper', amount: 240.0 }],
  },
};

function expectValid(input: unknown): LedgerEvent {
  const result = parseEvent(input);
  if (!result.success) throw new Error(result.error);
  return result.event;
}

function expectInvalid(input: unknown): string {
  const result = parseEvent(input);
  expect(result.success).toBe(false);
  return result.success ? '' : result.error;
}

describe('parseEvent', () => {
  it.each([
    ['invoice.created', invoiceCreated],
    ['payment.received', paymentReceived],
    ['bill.approved', billApproved],
  ])('accepts the SPEC sample for %s', (type, sample) => {
    expect(expectValid(sample).type).toBe(type);
  });

  it('accepts an invoice without the optional email, dueDate and line description', () => {
    const event = expectValid({
      ...invoiceCreated,
      data: {
        invoiceId: 'INV-1',
        customer: { id: 'CUS-1', name: 'No Email Ltd' },
        issueDate: '2026-11-11',
        currency: 'USD',
        lines: [{ sku: 'PLAN-PRO', quantity: 1, unitPrice: 49 }],
      },
    });
    expect(event.type).toBe('invoice.created');
  });

  it('rejects an invoice with no lines', () => {
    const error = expectInvalid({ ...invoiceCreated, data: { ...invoiceCreated.data, lines: [] } });
    expect(error).toContain('at least one line');
  });

  it('rejects an unknown event type', () => {
    expectInvalid({ ...invoiceCreated, type: 'invoice.deleted' });
  });

  it('rejects a bad currency code and names the field', () => {
    const error = expectInvalid({
      ...paymentReceived,
      data: { ...paymentReceived.data, currency: 'usd' },
    });
    expect(error).toContain('currency');
  });

  it('rejects a zero or negative payment amount', () => {
    expectInvalid({ ...paymentReceived, data: { ...paymentReceived.data, amount: 0 } });
    expectInvalid({ ...paymentReceived, data: { ...paymentReceived.data, amount: -5 } });
  });

  it('rejects a malformed date', () => {
    expectInvalid({ ...billApproved, data: { ...billApproved.data, billDate: '10/11/2026' } });
  });

  it('rejects a body that is not an object', () => {
    expectInvalid('not json');
    expectInvalid(null);
  });
});

describe('EVENT_FLOW', () => {
  it('maps billing events to O2C and procurement events to P2P', () => {
    expect(EVENT_FLOW['invoice.created']).toBe('O2C');
    expect(EVENT_FLOW['payment.received']).toBe('O2C');
    expect(EVENT_FLOW['bill.approved']).toBe('P2P');
  });
});

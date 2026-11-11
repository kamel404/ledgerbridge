import type { BillApprovedEvent, InvoiceCreatedEvent, PaymentReceivedEvent } from '@ledgerbridge/shared';

/** Sample events from SPEC §6, for tests. Override any field with `changes`. */

export function invoiceEvent(changes: Partial<InvoiceCreatedEvent['data']> = {}): InvoiceCreatedEvent {
  return {
    id: 'evt_inv_1',
    type: 'invoice.created',
    occurredAt: '2026-11-11T09:30:00Z',
    data: {
      invoiceId: 'INV-1042',
      customer: { id: 'CUS-77', name: 'Cedar Logistics SAL', email: 'ap@cedar.example' },
      issueDate: '2026-11-11',
      dueDate: '2026-12-11',
      currency: 'USD',
      lines: [{ sku: 'PLAN-PRO', description: 'Pro plan, monthly', quantity: 3, unitPrice: 49 }],
      ...changes,
    },
  };
}

export function paymentEvent(changes: Partial<PaymentReceivedEvent['data']> = {}): PaymentReceivedEvent {
  return {
    id: 'evt_pay_1',
    type: 'payment.received',
    occurredAt: '2026-11-20T14:02:00Z',
    data: {
      paymentId: 'PAY-5531',
      invoiceId: 'INV-1042',
      customerId: 'CUS-77',
      amount: 147,
      currency: 'USD',
      method: 'bank_transfer',
      receivedDate: '2026-11-20',
      ...changes,
    },
  };
}

export function billEvent(changes: Partial<BillApprovedEvent['data']> = {}): BillApprovedEvent {
  return {
    id: 'evt_bill_1',
    type: 'bill.approved',
    occurredAt: '2026-11-11T11:00:00Z',
    data: {
      billNumber: 'BILL-2209',
      vendor: { id: 'VEN-12', name: 'Beirut Office Supplies' },
      billDate: '2026-11-10',
      dueDate: '2026-12-10',
      currency: 'USD',
      lines: [{ expenseCategory: 'OFFICE_SUPPLIES', description: 'Printer paper', amount: 240 }],
      ...changes,
    },
  };
}

import { z } from 'zod';
import type { Flow } from './enums.js';

// Event payloads sent by the source apps (SPEC §6).
// Each schema is both the runtime validator and the TypeScript type.

const isoDate = z.iso.date(); // "2026-11-11"
const isoDateTime = z.iso.datetime({ offset: true }); // "2026-11-11T09:30:00Z"
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Expected a 3-letter ISO currency code');
const money = z.number().finite().nonnegative();
const positiveMoney = z.number().finite().positive();
const nonEmpty = z.string().trim().min(1);

/** Fields every event has, whatever its type. */
const envelope = {
  id: nonEmpty,
  occurredAt: isoDateTime,
};

// ---------------------------------------------------------------------------
// Order-to-Cash (billing app)
// ---------------------------------------------------------------------------

export const InvoiceLine = z.object({
  sku: nonEmpty,
  description: z.string().optional(),
  quantity: z.number().finite().positive(),
  unitPrice: money,
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const InvoiceCreatedEvent = z.object({
  ...envelope,
  type: z.literal('invoice.created'),
  data: z.object({
    invoiceId: nonEmpty,
    customer: z.object({
      id: nonEmpty,
      name: nonEmpty,
      email: z.email().optional(),
    }),
    issueDate: isoDate,
    dueDate: isoDate.optional(),
    currency: currencyCode,
    // An invoice with no lines is rejected at the door: the ERP would refuse it.
    lines: z.array(InvoiceLine).min(1, 'An invoice needs at least one line'),
  }),
});
export type InvoiceCreatedEvent = z.infer<typeof InvoiceCreatedEvent>;

export const PaymentReceivedEvent = z.object({
  ...envelope,
  type: z.literal('payment.received'),
  data: z.object({
    paymentId: nonEmpty,
    invoiceId: nonEmpty,
    customerId: nonEmpty,
    amount: positiveMoney,
    currency: currencyCode,
    method: nonEmpty,
    receivedDate: isoDate,
  }),
});
export type PaymentReceivedEvent = z.infer<typeof PaymentReceivedEvent>;

// ---------------------------------------------------------------------------
// Procure-to-Pay (procurement app, CSV import)
// ---------------------------------------------------------------------------

export const BillLine = z.object({
  expenseCategory: nonEmpty,
  description: z.string().optional(),
  amount: positiveMoney,
});
export type BillLine = z.infer<typeof BillLine>;

export const BillApprovedEvent = z.object({
  ...envelope,
  type: z.literal('bill.approved'),
  data: z.object({
    billNumber: nonEmpty,
    vendor: z.object({
      id: nonEmpty,
      name: nonEmpty,
    }),
    billDate: isoDate,
    dueDate: isoDate.optional(),
    currency: currencyCode,
    lines: z.array(BillLine).min(1, 'A bill needs at least one line'),
  }),
});
export type BillApprovedEvent = z.infer<typeof BillApprovedEvent>;

// ---------------------------------------------------------------------------
// Any event
// ---------------------------------------------------------------------------

/** Any supported event. Validation picks the right schema from `type`. */
export const LedgerEvent = z.discriminatedUnion('type', [
  InvoiceCreatedEvent,
  PaymentReceivedEvent,
  BillApprovedEvent,
]);
export type LedgerEvent = z.infer<typeof LedgerEvent>;
export type EventType = LedgerEvent['type'];

/** Which business flow each event type belongs to. */
export const EVENT_FLOW = {
  'invoice.created': 'O2C',
  'payment.received': 'O2C',
  'bill.approved': 'P2P',
} as const satisfies Record<EventType, Flow>;

export const EVENT_TYPES = Object.keys(EVENT_FLOW) as EventType[];

export type ParseEventResult =
  | { success: true; event: LedgerEvent }
  | { success: false; error: string };

/**
 * Validates unknown input (e.g. a webhook body) as a LedgerEvent.
 * On failure, `error` is a readable multi-line message listing every problem.
 */
export function parseEvent(input: unknown): ParseEventResult {
  const result = LedgerEvent.safeParse(input);
  if (result.success) {
    return { success: true, event: result.data };
  }
  return { success: false, error: z.prettifyError(result.error) };
}

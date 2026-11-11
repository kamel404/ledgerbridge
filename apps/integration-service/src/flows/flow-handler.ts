import type { EventType, LedgerEvent } from '@ledgerbridge/shared';
import type { ErpRecordType } from '../erp-client/erp-client.js';

/** The ERP record an event produced, stored on the sync record on success. */
export interface FlowResult {
  erpRecordType: ErpRecordType;
  erpRecordId: string;
}

export type EventOfType<T extends EventType> = Extract<LedgerEvent, { type: T }>;

/**
 * One handler per event type. Adding an integration = a zod schema in
 * @ledgerbridge/shared + a class implementing this + one line in FlowsModule.
 * The worker never changes (SPEC §8.2).
 *
 * Handlers throw RetryableError / PermanentError; anything else is treated as
 * retryable by classifyError().
 */
export interface FlowHandler<T extends EventType = EventType> {
  readonly eventType: T;
  handle(event: EventOfType<T>): Promise<FlowResult>;
}

export const FLOW_HANDLERS = Symbol('FLOW_HANDLERS');

/** Business key shown on the dashboard and searchable (SPEC §8.5). */
export function businessKeyOf(event: LedgerEvent): string {
  switch (event.type) {
    case 'invoice.created':
      return event.data.invoiceId;
    case 'payment.received':
      return event.data.paymentId;
    case 'bill.approved':
      return event.data.billNumber;
  }
}

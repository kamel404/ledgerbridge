import type { PaymentReceivedEvent } from '@ledgerbridge/shared';
import { PermanentError } from '../../errors/integration-errors.js';
import type { ErpRecord } from '../../erp-client/erp-client.js';
import { currencyIdForCode } from '../../lookups/lookups.js';
import { round2 } from '../money.js';

/**
 * payment.received -> ERP customerPayment (SPEC §6.1), plus the business rules
 * checked before writing. Pure functions over already-fetched ERP records.
 */

interface Ref {
  id?: string;
  externalId?: string;
}

/**
 * Throws PermanentError if the payment can't be applied to this invoice:
 * different customer, different currency, or more than what's left to pay.
 *
 * `existingPayment` is this same payment if the ERP already has it (the event
 * is being processed again). Its earlier amount on this invoice is added back
 * to the remaining balance, otherwise a retry of an already-applied payment
 * would look like an overpayment.
 */
export function checkPaymentRules(
  event: PaymentReceivedEvent,
  invoice: ErpRecord,
  existingPayment?: ErpRecord,
): void {
  const { data } = event;

  const invoiceCustomer = (invoice.entity as Ref | undefined)?.externalId;
  if (invoiceCustomer !== undefined && invoiceCustomer !== data.customerId) {
    throw new PermanentError(
      'PAYMENT_CUSTOMER_MISMATCH',
      `Payment ${data.paymentId} is from customer ${data.customerId} but invoice ${data.invoiceId} belongs to ${invoiceCustomer}`,
    );
  }

  const invoiceCurrency = (invoice.currency as Ref | undefined)?.id;
  const paymentCurrency = currencyIdForCode(data.currency);
  if (invoiceCurrency !== paymentCurrency) {
    throw new PermanentError(
      'PAYMENT_CURRENCY_MISMATCH',
      `Payment ${data.paymentId} is in ${data.currency} but invoice ${data.invoiceId} uses a different currency (ERP currency ${invoiceCurrency})`,
    );
  }

  const remaining = Number(invoice.amountRemaining ?? 0);
  const alreadyApplied = existingPayment ? appliedTo(existingPayment, invoice.id) : 0;
  const available = round2(remaining + alreadyApplied);
  if (round2(data.amount) > available) {
    throw new PermanentError(
      'PAYMENT_EXCEEDS_BALANCE',
      `Payment ${data.paymentId} of ${data.amount} exceeds the remaining balance ${available} of invoice ${data.invoiceId}`,
    );
  }
}

export function mapPayment(event: PaymentReceivedEvent, invoiceInternalId: string): Record<string, unknown> {
  const { data } = event;
  return {
    customer: { externalId: data.customerId },
    tranDate: data.receivedDate,
    currency: { id: currencyIdForCode(data.currency) },
    payment: data.amount,
    paymentMethod: data.method,
    apply: { items: [{ doc: { id: invoiceInternalId }, amount: data.amount }] },
  };
}

/** How much of `payment` is applied to the invoice with this internal ID. */
function appliedTo(payment: ErpRecord, invoiceId: string): number {
  const items = (payment.apply as { items?: { doc?: Ref; amount?: number }[] } | undefined)?.items ?? [];
  return round2(items.filter((i) => i.doc?.id === invoiceId).reduce((sum, i) => sum + (i.amount ?? 0), 0));
}

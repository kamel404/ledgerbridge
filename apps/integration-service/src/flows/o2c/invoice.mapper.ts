import type { InvoiceCreatedEvent } from '@ledgerbridge/shared';
import { PermanentError } from '../../errors/integration-errors.js';
import { currencyIdForCode, itemIdForSku } from '../../lookups/lookups.js';

/**
 * invoice.created -> ERP bodies (SPEC §6.1). Pure functions: no HTTP, easy to test.
 * The external ID is not in the body: it goes in the URL (PUT /{type}/eid:{id}).
 */

export function mapCustomer(event: InvoiceCreatedEvent): Record<string, unknown> {
  const { customer } = event.data;
  return {
    companyName: customer.name,
    ...(customer.email && { email: customer.email }),
  };
}

export function mapInvoice(event: InvoiceCreatedEvent): Record<string, unknown> {
  const { data } = event;
  // The schema already refuses this; checked again so the mapper is safe on its own.
  if (data.lines.length === 0) {
    throw new PermanentError('EMPTY_INVOICE', `Invoice ${data.invoiceId} has no lines`);
  }
  return {
    tranId: data.invoiceId,
    entity: { externalId: data.customer.id },
    tranDate: data.issueDate,
    ...(data.dueDate && { dueDate: data.dueDate }),
    currency: { id: currencyIdForCode(data.currency) },
    item: {
      items: data.lines.map((line) => ({
        item: { id: itemIdForSku(line.sku) },
        ...(line.description && { description: line.description }),
        quantity: line.quantity,
        rate: line.unitPrice,
      })),
    },
  };
}

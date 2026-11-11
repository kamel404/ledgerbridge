import { Injectable } from '@nestjs/common';
import type { InvoiceCreatedEvent } from '@ledgerbridge/shared';
import { ErpClient } from '../../erp-client/erp-client.js';
import type { FlowHandler, FlowResult } from '../flow-handler.js';
import { mapCustomer, mapInvoice } from './invoice.mapper.js';

/** invoice.created: upsert the customer, then the invoice that references it (SPEC §6.1). */
@Injectable()
export class InvoiceCreatedHandler implements FlowHandler<'invoice.created'> {
  readonly eventType = 'invoice.created' as const;

  constructor(private readonly erp: ErpClient) {}

  async handle(event: InvoiceCreatedEvent): Promise<FlowResult> {
    // Map both bodies first: an unknown SKU fails before anything is written.
    const customer = mapCustomer(event);
    const invoice = mapInvoice(event);

    await this.erp.upsert('customer', event.data.customer.id, customer);
    const { id } = await this.erp.upsert('invoice', event.data.invoiceId, invoice);
    return { erpRecordType: 'invoice', erpRecordId: id };
  }
}

import { Injectable } from '@nestjs/common';
import type { PaymentReceivedEvent } from '@ledgerbridge/shared';
import { RetryableError } from '../../errors/integration-errors.js';
import { ErpClient } from '../../erp-client/erp-client.js';
import type { FlowHandler, FlowResult } from '../flow-handler.js';
import { checkPaymentRules, mapPayment } from './payment.mapper.js';

/**
 * payment.received (SPEC §6.1):
 * 1. find the invoice by external ID; missing -> retryable (events can arrive
 *    out of order, the invoice may simply not be here yet),
 * 2. check customer, currency and balance -> permanent on violation,
 * 3. upsert the customerPayment applied to that invoice.
 */
@Injectable()
export class PaymentReceivedHandler implements FlowHandler<'payment.received'> {
  readonly eventType = 'payment.received' as const;

  constructor(private readonly erp: ErpClient) {}

  async handle(event: PaymentReceivedEvent): Promise<FlowResult> {
    const { paymentId, invoiceId } = event.data;

    const invoice = await this.erp.getByExternalId('invoice', invoiceId);
    if (!invoice) {
      throw new RetryableError(
        'INVOICE_NOT_FOUND',
        `Invoice ${invoiceId} for payment ${paymentId} is not in the ERP yet`,
      );
    }

    const existing = await this.erp.getByExternalId('customerPayment', paymentId);
    checkPaymentRules(event, invoice, existing);

    const { id } = await this.erp.upsert('customerPayment', paymentId, mapPayment(event, invoice.id));
    return { erpRecordType: 'customerPayment', erpRecordId: id };
  }
}

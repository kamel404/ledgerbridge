import { Module } from '@nestjs/common';
import { ErpClientModule } from '../erp-client/erp-client.module.js';
import { FLOW_HANDLERS, type FlowHandler } from './flow-handler.js';
import { FlowRegistry } from './flow-registry.js';
import { InvoiceCreatedHandler } from './o2c/invoice-created.handler.js';
import { PaymentReceivedHandler } from './o2c/payment-received.handler.js';
import { BillApprovedHandler } from './p2p/bill-approved.handler.js';

/** Every flow handler. Adding an event type = add its handler here. */
const HANDLERS = [InvoiceCreatedHandler, PaymentReceivedHandler, BillApprovedHandler];

@Module({
  imports: [ErpClientModule],
  providers: [
    ...HANDLERS,
    { provide: FLOW_HANDLERS, useFactory: (...handlers: FlowHandler[]) => handlers, inject: HANDLERS },
    FlowRegistry,
  ],
  exports: [FlowRegistry],
})
export class FlowsModule {}

import { Injectable } from '@nestjs/common';
import type { BillApprovedEvent } from '@ledgerbridge/shared';
import { ErpClient } from '../../erp-client/erp-client.js';
import type { FlowHandler, FlowResult } from '../flow-handler.js';
import { mapVendor, mapVendorBill } from './bill.mapper.js';

/** bill.approved: upsert the vendor, then the vendor bill (SPEC §6.2). */
@Injectable()
export class BillApprovedHandler implements FlowHandler<'bill.approved'> {
  readonly eventType = 'bill.approved' as const;

  constructor(private readonly erp: ErpClient) {}

  async handle(event: BillApprovedEvent): Promise<FlowResult> {
    // Map first: an unknown expense category fails before the vendor is written.
    const vendor = mapVendor(event);
    const bill = mapVendorBill(event);

    await this.erp.upsert('vendor', event.data.vendor.id, vendor);
    const { id } = await this.erp.upsert('vendorBill', event.data.billNumber, bill);
    return { erpRecordType: 'vendorBill', erpRecordId: id };
  }
}

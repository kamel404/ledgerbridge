import type { BillApprovedEvent } from '@ledgerbridge/shared';
import { PermanentError } from '../../errors/integration-errors.js';
import { accountIdForCategory, currencyIdForCode } from '../../lookups/lookups.js';

/**
 * bill.approved -> ERP bodies (SPEC §6.2). Pure functions.
 * An unknown expense category throws PermanentError (UNKNOWN_EXPENSE_CATEGORY):
 * finance must add the mapping first.
 */

export function mapVendor(event: BillApprovedEvent): Record<string, unknown> {
  return { companyName: event.data.vendor.name };
}

export function mapVendorBill(event: BillApprovedEvent): Record<string, unknown> {
  const { data } = event;
  if (data.lines.length === 0) {
    throw new PermanentError('EMPTY_BILL', `Bill ${data.billNumber} has no lines`);
  }
  return {
    tranId: data.billNumber,
    entity: { externalId: data.vendor.id },
    tranDate: data.billDate,
    ...(data.dueDate && { dueDate: data.dueDate }),
    currency: { id: currencyIdForCode(data.currency) },
    expense: {
      items: data.lines.map((line) => ({
        account: { id: accountIdForCategory(line.expenseCategory) },
        amount: line.amount,
        ...(line.description && { memo: line.description }),
      })),
    },
  };
}

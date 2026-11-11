import { billEvent } from '../../test-support/events.js';
import { mapVendor, mapVendorBill } from './bill.mapper.js';

describe('bill mapper', () => {
  it('maps the SPEC §6.2 example to an ERP vendor bill', () => {
    expect(mapVendorBill(billEvent())).toEqual({
      tranId: 'BILL-2209',
      entity: { externalId: 'VEN-12' },
      tranDate: '2026-11-10',
      dueDate: '2026-12-10',
      currency: { id: '1' },
      expense: { items: [{ account: { id: '6110' }, amount: 240, memo: 'Printer paper' }] },
    });
  });

  it('maps the vendor', () => {
    expect(mapVendor(billEvent())).toEqual({ companyName: 'Beirut Office Supplies' });
  });

  it('maps several lines and leaves out missing optional fields', () => {
    const bill = mapVendorBill(
      billEvent({
        dueDate: undefined,
        lines: [
          { expenseCategory: 'SOFTWARE', amount: 99 },
          { expenseCategory: 'TRAVEL', description: 'Flight BEY-CDG', amount: 420.5 },
        ],
      }),
    );
    expect(bill).not.toHaveProperty('dueDate');
    expect(bill.expense).toEqual({
      items: [
        { account: { id: '6120' }, amount: 99 },
        { account: { id: '6130' }, amount: 420.5, memo: 'Flight BEY-CDG' },
      ],
    });
  });

  it('refuses an unknown expense category as a permanent error', () => {
    const event = billEvent({ lines: [{ expenseCategory: 'YACHTS', amount: 1 }] });
    expect(() => mapVendorBill(event)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_EXPENSE_CATEGORY', errorClass: 'permanent' }),
    );
  });

  it('refuses a zero-line bill as a permanent error', () => {
    expect(() => mapVendorBill(billEvent({ lines: [] }))).toThrow(expect.objectContaining({ code: 'EMPTY_BILL' }));
  });
});

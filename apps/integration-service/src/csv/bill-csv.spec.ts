import { createHash } from 'node:crypto';
import { parseCsv } from './csv-format.js';
import { csvEventId, errorsCsv, readBillCsv } from './bill-csv.js';

const HEADER = 'bill_number,vendor_id,vendor_name,bill_date,due_date,currency,expense_category,description,amount';
const AT = '2026-11-12T10:00:00.000Z';
const read = (...lines: string[]) => readBillCsv(Buffer.from([HEADER, ...lines].join('\n')), AT);

describe('readBillCsv', () => {
  it('groups rows sharing a bill_number into one bill with several lines', () => {
    const r = read(
      'B-1,V-1,Acme,2026-11-01,2026-12-01,USD,SOFTWARE,Licences,120.50',
      'B-1,V-1,Acme,2026-11-01,2026-12-01,USD,OFFICE_SUPPLIES,,24',
      'B-2,V-2,Globex,2026-11-02,,EUR,TRAVEL,Train,80',
    );
    expect(r.rejected).toEqual([]);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toEqual({
      id: csvEventId(r.fileHash, 'B-1'),
      type: 'bill.approved',
      occurredAt: AT,
      data: {
        billNumber: 'B-1',
        vendor: { id: 'V-1', name: 'Acme' },
        billDate: '2026-11-01',
        dueDate: '2026-12-01',
        currency: 'USD',
        lines: [
          { expenseCategory: 'SOFTWARE', description: 'Licences', amount: 120.5 },
          { expenseCategory: 'OFFICE_SUPPLIES', amount: 24 },
        ],
      },
    });
    expect(r.events[1]!.data).not.toHaveProperty('dueDate');
  });

  it('gives deterministic IDs: csv:<sha256 of the file>:<bill_number>', () => {
    const text = `${HEADER}\nB-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,10\n`;
    const hash = createHash('sha256').update(text).digest('hex');
    const a = readBillCsv(Buffer.from(text), AT);
    const b = readBillCsv(Buffer.from(text), '2027-01-01T00:00:00Z'); // uploaded again later
    expect(a.events[0]!.id).toBe(`csv:${hash}:B-1`);
    expect(b.events[0]!.id).toBe(a.events[0]!.id);
    expect(readBillCsv(Buffer.from(text + '\n'), AT).events[0]!.id).not.toBe(a.events[0]!.id); // any change = new file
  });

  it.each([
    ['bad date', 'B-1,V-1,Acme,2026-13-45,,USD,SOFTWARE,,10', 'bill_date "2026-13-45" is not a date'],
    ['impossible date', 'B-1,V-1,Acme,2026-02-30,,USD,SOFTWARE,,10', 'bill_date "2026-02-30" is not a date'],
    ['missing amount', 'B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,', 'amount is missing'],
    ['negative amount', 'B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,-5', 'amount "-5" must be a positive number'],
    ['three decimals', 'B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,1.005', 'at most 2 decimals'],
    ['unknown category', 'B-1,V-1,Acme,2026-11-01,,USD,YACHTS,,10', 'Unknown expense_category "YACHTS"'],
    ['unknown currency', 'B-1,V-1,Acme,2026-11-01,,XYZ,SOFTWARE,,10', 'Unknown currency "XYZ"'],
    ['missing vendor', 'B-1,,Acme,2026-11-01,,USD,SOFTWARE,,10', 'vendor_id is missing'],
    ['wrong field count', 'B-1,V-1,Acme', 'Expected 9 fields, found 3'],
  ])('rejects a row with a reason: %s', (_, line, reason) => {
    const r = read(line);
    expect(r.events).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.row).toBe(2);
    expect(r.rejected[0]!.reason).toContain(reason);
  });

  it('lists every problem of a row', () => {
    const r = read('B-1,V-1,,nope,,USD,YACHTS,,');
    expect(r.rejected[0]!.reason.split('; ')).toHaveLength(4);
  });

  it('rejects a whole bill if one of its rows is invalid, and imports the other bills', () => {
    const r = read(
      'B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,10',
      'B-2,V-2,Globex,2026-11-01,,USD,SOFTWARE,,10',
      'B-1,V-1,Acme,2026-11-01,,USD,YACHTS,,99',
    );
    expect(r.events.map((e) => e.data.billNumber)).toEqual(['B-2']);
    expect(r.rejected.map((x) => [x.row, x.reason])).toEqual([
      [2, 'Bill B-1 has invalid rows (row 4), so none of it was imported'],
      [4, expect.stringContaining('Unknown expense_category')],
    ]);
  });

  it('rejects a bill whose rows disagree on vendor, dates or currency', () => {
    const r = read('B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,10', 'B-1,V-1,Acme,2026-11-01,,EUR,TRAVEL,,5');
    expect(r.events).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'Rows of bill B-1 disagree on currency',
      'Rows of bill B-1 disagree on currency',
    ]);
  });

  it('accepts columns in any order, extra columns, spaces and a BOM', () => {
    const text = '﻿amount, bill_number,vendor_id,vendor_name,bill_date,due_date,currency,expense_category,description,notes\n' +
      ' 10 ,B-1,V-1,Acme,2026-11-01,,USD,SOFTWARE,,ignored\n';
    const r = readBillCsv(Buffer.from(text), AT);
    expect(r.rejected).toEqual([]);
    expect(r.events[0]!.data.lines).toEqual([{ expenseCategory: 'SOFTWARE', amount: 10 }]);
  });

  it.each([
    ['missing columns', 'bill_number,amount\nB-1,10', 'Missing column(s): vendor_id, vendor_name'],
    ['empty file', '', 'The file is empty.'],
    ['header only', HEADER, 'header but no rows'],
    ['broken CSV', `${HEADER}\n"B-1,unclosed`, 'Not a valid CSV file'],
  ])('refuses the whole file: %s', (_, text, reason) => {
    const r = readBillCsv(Buffer.from(text), AT);
    expect(r.events).toEqual([]);
    expect(r.fileError).toContain(reason);
  });

  it('refuses a file that is not UTF-8', () => {
    expect(readBillCsv(Buffer.from([0xff, 0xfe, 0x00, 0x41]), AT).fileError).toContain('not UTF-8');
  });
});

describe('errorsCsv', () => {
  it('writes the original columns plus a reason column', () => {
    const r = read('B-1,V-1,"Acme, Inc",2026-11-01,,USD,YACHTS,,10');
    expect(parseCsv(errorsCsv(r))).toEqual([
      [...HEADER.split(','), 'reason'],
      ['B-1', 'V-1', 'Acme, Inc', '2026-11-01', '', 'USD', 'YACHTS', '', '10', expect.stringContaining('YACHTS')],
    ]);
  });

  it('writes just the reason when the whole file was refused', () => {
    expect(parseCsv(errorsCsv(readBillCsv(Buffer.from(''), AT)))).toEqual([['reason'], ['The file is empty.']]);
  });
});

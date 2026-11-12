import { createHash } from 'node:crypto';
import { parseEvent, type BillApprovedEvent } from '@ledgerbridge/shared';
import { ACCOUNT_IDS, CURRENCY_IDS } from '../lookups/lookups.js';
import { CsvSyntaxError, parseCsv, toCsv } from './csv-format.js';

/** Columns of a vendor-bill CSV (SPEC §6.2). Order doesn't matter; extra columns are ignored. */
export const BILL_CSV_COLUMNS = [
  'bill_number',
  'vendor_id',
  'vendor_name',
  'bill_date',
  'due_date',
  'currency',
  'expense_category',
  'description',
  'amount',
] as const;
type Column = (typeof BILL_CSV_COLUMNS)[number];

/** Safety limit: a bigger file is refused as a whole. */
export const MAX_ROWS = 10_000;

export interface RejectedRow {
  /** Spreadsheet row number: the header is row 1. */
  row: number;
  /** The row's values, in the file's own column order. */
  values: string[];
  reason: string;
}

export interface BillCsvResult {
  /** sha256 of the file bytes, part of every event ID. */
  fileHash: string;
  /** One bill.approved per bill number whose rows are all valid. */
  events: BillApprovedEvent[];
  rejected: RejectedRow[];
  /** The file's header row (empty if unreadable). */
  header: string[];
  /** Set when the file can't be used at all; then there are no events. */
  fileError?: string;
}

/**
 * Event ID for one bill of one file: `csv:<sha256 of file>:<bill_number>`.
 * The same file uploaded again gives the same IDs, so the ingest dedup
 * ignores it (SPEC §6.2). A corrected file has a different hash: its bills
 * are new events, and the ERP upsert updates the existing bills.
 */
export function csvEventId(fileHash: string, billNumber: string): string {
  return `csv:${fileHash}:${billNumber}`;
}

interface ValidRow {
  row: number;
  values: string[];
  billNumber: string;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate?: string;
  currency: string;
  expenseCategory: string;
  description?: string;
  amount: number;
}

/**
 * Reads a vendor-bill CSV and turns it into bill.approved events.
 *
 * - Rows sharing a bill_number become the lines of one bill.
 * - A row that fails validation is rejected with a reason.
 * - If any row of a bill is rejected, the whole bill is: sending only its
 *   good rows would create a bill with the wrong total.
 * - Rows of one bill must agree on vendor, dates and currency.
 * - Unknown categories and currencies are rejected here, so finance sees
 *   them in the errors file right away instead of as FAILED syncs later.
 */
export function readBillCsv(content: Uint8Array, occurredAt: string): BillCsvResult {
  const fileHash = createHash('sha256').update(content).digest('hex');
  const fail = (fileError: string, header: string[] = []): BillCsvResult => ({
    fileHash,
    events: [],
    rejected: [],
    header,
    fileError,
  });

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return fail('The file is not UTF-8 text. Save it as "CSV UTF-8".');
  }

  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (err) {
    return fail(err instanceof CsvSyntaxError ? `Not a valid CSV file: ${err.message}` : String(err));
  }
  const [rawHeader, ...dataRows] = rows;
  if (!rawHeader) return fail('The file is empty.');
  const header = rawHeader.map((h) => h.trim());

  const missing = BILL_CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return fail(`Missing column(s): ${missing.join(', ')}`, header);
  if (dataRows.length === 0) return fail('The file has a header but no rows.', header);
  if (dataRows.length > MAX_ROWS) return fail(`Too many rows (${dataRows.length}); the limit is ${MAX_ROWS}.`, header);

  const index = Object.fromEntries(BILL_CSV_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<Column, number>;
  const rejected: RejectedRow[] = [];
  const bills = new Map<string, { valid: ValidRow[]; invalid: RejectedRow[] }>();

  dataRows.forEach((values, i) => {
    const row = i + 2; // header is row 1
    if (values.length !== header.length) {
      rejected.push({ row, values, reason: `Expected ${header.length} fields, found ${values.length}` });
      return;
    }
    const get = (c: Column) => values[index[c]]!.trim();
    const result = validateRow(get);
    const billNumber = get('bill_number');
    if (!billNumber) {
      // Without a bill number the row can't be grouped with anything.
      rejected.push({ row, values, reason: result.errors.join('; ') });
      return;
    }
    const group = bills.get(billNumber) ?? { valid: [], invalid: [] };
    bills.set(billNumber, group);
    if (result.errors.length) group.invalid.push({ row, values, reason: result.errors.join('; ') });
    else group.valid.push({ row, values, ...result.fields! });
  });

  const events: BillApprovedEvent[] = [];
  for (const [billNumber, { valid, invalid }] of bills) {
    if (invalid.length) {
      const rowsList = invalid.map((r) => r.row).join(', ');
      rejected.push(...invalid);
      for (const v of valid) {
        rejected.push({ row: v.row, values: v.values, reason: `Bill ${billNumber} has invalid rows (row ${rowsList}), so none of it was imported` });
      }
      continue;
    }

    const disagree = (['vendorId', 'vendorName', 'billDate', 'dueDate', 'currency'] as const).filter(
      (f) => new Set(valid.map((v) => v[f] ?? '')).size > 1,
    );
    if (disagree.length) {
      const reason = `Rows of bill ${billNumber} disagree on ${disagree.map(columnName).join(', ')}`;
      for (const v of valid) rejected.push({ row: v.row, values: v.values, reason });
      continue;
    }

    const first = valid[0]!;
    const event = {
      id: csvEventId(fileHash, billNumber),
      type: 'bill.approved' as const,
      occurredAt,
      data: {
        billNumber,
        vendor: { id: first.vendorId, name: first.vendorName },
        billDate: first.billDate,
        ...(first.dueDate && { dueDate: first.dueDate }),
        currency: first.currency,
        lines: valid.map((v) => ({
          expenseCategory: v.expenseCategory,
          ...(v.description && { description: v.description }),
          amount: v.amount,
        })),
      },
    };
    // Same schema the webhook uses, as a last check.
    const parsed = parseEvent(event);
    if (!parsed.success || parsed.event.type !== 'bill.approved') {
      const reason = parsed.success ? 'Not a bill' : parsed.error.replaceAll('\n', ' ');
      for (const v of valid) rejected.push({ row: v.row, values: v.values, reason });
      continue;
    }
    events.push(parsed.event);
  }

  rejected.sort((a, b) => a.row - b.row);
  return { fileHash, events, rejected, header };
}

/** The `rejected/<file>.errors.csv` content: original columns + reason. */
export function errorsCsv(result: BillCsvResult): string {
  if (result.fileError) return toCsv([['reason'], [result.fileError]]);
  return toCsv([[...result.header, 'reason'], ...result.rejected.map((r) => [...r.values, r.reason])]);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

function validDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value; // rejects 2026-02-30
}

function validateRow(get: (c: Column) => string): { errors: string[]; fields?: Omit<ValidRow, 'row' | 'values'> } {
  const errors: string[] = [];
  const billNumber = get('bill_number');
  const vendorId = get('vendor_id');
  const vendorName = get('vendor_name');
  const billDate = get('bill_date');
  const dueDate = get('due_date');
  const currency = get('currency');
  const category = get('expense_category');
  const amount = get('amount');

  if (!billNumber) errors.push('bill_number is missing');
  else if (billNumber.length > 64) errors.push('bill_number is longer than 64 characters');
  if (!vendorId) errors.push('vendor_id is missing');
  if (!vendorName) errors.push('vendor_name is missing');

  if (!billDate) errors.push('bill_date is missing');
  else if (!validDate(billDate)) errors.push(`bill_date "${billDate}" is not a date (use YYYY-MM-DD)`);
  if (dueDate && !validDate(dueDate)) errors.push(`due_date "${dueDate}" is not a date (use YYYY-MM-DD)`);

  if (!currency) errors.push('currency is missing');
  else if (!Object.hasOwn(CURRENCY_IDS, currency)) errors.push(`Unknown currency "${currency}"`);

  if (!category) errors.push('expense_category is missing');
  else if (!Object.hasOwn(ACCOUNT_IDS, category)) {
    errors.push(`Unknown expense_category "${category}" (it needs an ERP account mapping first)`);
  }

  if (!amount) errors.push('amount is missing');
  else if (!AMOUNT.test(amount) || Number(amount) <= 0) {
    errors.push(`amount "${amount}" must be a positive number with at most 2 decimals, like 120.50`);
  }

  if (errors.length) return { errors };
  return {
    errors,
    fields: {
      billNumber,
      vendorId,
      vendorName,
      billDate,
      ...(dueDate && { dueDate }),
      currency,
      expenseCategory: category,
      ...(get('description') && { description: get('description') }),
      amount: Number(amount),
    },
  };
}

function columnName(field: 'vendorId' | 'vendorName' | 'billDate' | 'dueDate' | 'currency'): Column {
  return ({ vendorId: 'vendor_id', vendorName: 'vendor_name', billDate: 'bill_date', dueDate: 'due_date', currency: 'currency' } as const)[field];
}

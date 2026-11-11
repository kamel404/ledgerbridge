import { Injectable } from '@nestjs/common';
import { NetSuiteError } from '../common/netsuite-error.js';
import type { StoredRecord } from '../records/record-store.js';
import { RECORD_TYPE_DEFS, SYSTEM_COLUMNS, toRecordType, type RecordType } from '../records/record-types.js';
import { RecordsService } from '../records/records.service.js';
import { parseSuiteQl, SuiteQlSyntaxError, type Condition } from './suiteql-parser.js';

export const MAX_LIMIT = 1000;

type Value = string | number | null;
type Row = Record<string, Value>;

export interface SuiteQlResult {
  links: never[];
  count: number;
  hasMore: boolean;
  items: Row[];
  offset: number;
  totalResults: number;
}

/**
 * Runs a SuiteQL query against the records.
 *
 * Like real SuiteQL, result column names are lowercase ("tranid",
 * "amountremaining") and a reference column returns the referenced record's
 * internal ID. Sub-lists (invoice lines, payment applications) are not columns.
 */
@Injectable()
export class SuiteQlService {
  constructor(private readonly records: RecordsService) {}

  async run(q: string, limit = MAX_LIMIT, offset = 0): Promise<SuiteQlResult> {
    let query;
    try {
      query = parseSuiteQl(q);
    } catch (err) {
      if (err instanceof SuiteQlSyntaxError) throw NetSuiteError.badRequest('INVALID_SUITEQL', err.message);
      throw err;
    }

    const type = toRecordType(query.from);
    if (!type) throw NetSuiteError.badRequest('INVALID_SUITEQL', `Unknown table '${query.from}'`);
    const known = knownColumns(type);
    const column = (name: string): string => {
      const lower = name.toLowerCase();
      if (!known.includes(lower)) {
        throw NetSuiteError.badRequest('INVALID_SUITEQL', `Unknown column '${name}' for table ${type}`);
      }
      return lower;
    };

    const selected = query.columns === '*' ? known : query.columns.map(column);
    const where = query.where.map((c) => ({ ...c, field: column(c.field) }));
    const orderBy = query.orderBy && { ...query.orderBy, field: column(query.orderBy.field) };

    let rows = (await this.records.list(type)).map((r) => toRow(type, r));
    rows = rows.filter((row) => where.every((c) => matches(row[c.field] ?? null, c)));
    if (orderBy) {
      const sign = orderBy.direction === 'DESC' ? -1 : 1;
      rows.sort((a, b) => sign * compareForSort(a[orderBy.field] ?? null, b[orderBy.field] ?? null));
    }

    const page = rows.slice(offset, offset + limit);
    return {
      links: [],
      count: page.length,
      hasMore: offset + page.length < rows.length,
      items: page.map((row) => Object.fromEntries(selected.map((c) => [c, row[c] ?? null]))),
      offset,
      totalResults: rows.length,
    };
  }
}

function knownColumns(type: RecordType): string[] {
  return [...SYSTEM_COLUMNS, ...RECORD_TYPE_DEFS[type].columns].map((c) => c.toLowerCase());
}

/** Flattens a record into a row: lowercase keys, references reduced to their ID. */
function toRow(type: RecordType, record: StoredRecord): Row {
  const row: Row = {
    id: record.id,
    externalid: record.externalId ?? null,
    createddate: record.createdDate,
    lastmodifieddate: record.lastModifiedDate,
  };
  for (const col of RECORD_TYPE_DEFS[type].columns) {
    const value = record.fields[col] ?? record.computed[col];
    row[col.toLowerCase()] = toScalar(value);
  }
  return row;
}

function toScalar(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id);
  return String(value);
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Compares numerically when both sides look like numbers, otherwise as text. */
function compare(a: string | number, b: string | number): number {
  const an = typeof a === 'number' ? a : NUMERIC.test(a) ? Number(a) : NaN;
  const bn = typeof b === 'number' ? b : NUMERIC.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** SQL semantics: any comparison with NULL is false. */
function matches(value: Value, c: Condition): boolean {
  if (value === null) return false;
  const diff = compare(value, c.value);
  switch (c.op) {
    case '=':
      return diff === 0;
    case '!=':
      return diff !== 0;
    case '<':
      return diff < 0;
    case '<=':
      return diff <= 0;
    case '>':
      return diff > 0;
    case '>=':
      return diff >= 0;
  }
}

/** NULLs sort last. */
function compareForSort(a: Value, b: Value): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

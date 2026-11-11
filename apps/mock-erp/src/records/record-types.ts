import { z } from 'zod';

/**
 * The five record types the mock supports (SPEC §7.2), and for each one:
 * - the schema of the fields a client may send,
 * - which fields reference other records,
 * - the columns SuiteQL can select.
 *
 * Field names follow NetSuite's REST record API (entity, tranId, tranDate,
 * item.items[], expense.items[], ...). They are simplified: real NetSuite has
 * many more fields and some differ per account.
 */

export const RECORD_TYPES = ['customer', 'vendor', 'invoice', 'customerPayment', 'vendorBill'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Case-insensitive lookup ("customerpayment" -> "customerPayment"). */
export function toRecordType(value: string): RecordType | undefined {
  const lower = value.toLowerCase();
  return RECORD_TYPES.find((t) => t.toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const numericId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);

/**
 * Reference to another record in this ERP: { "id": "12" } or
 * { "externalId": "CUS-77" }. Stored resolved as { id, externalId?, refName? }.
 */
export const RecordRef = z
  .strictObject({
    id: numericId.optional(),
    externalId: z.string().min(1).optional(),
    refName: z.string().optional(),
  })
  .refine((r) => r.id !== undefined || r.externalId !== undefined, {
    message: 'A reference needs "id" or "externalId"',
  });
export type RecordRef = z.infer<typeof RecordRef>;

/**
 * Reference to a list value that the mock does not store as a record
 * (item, account, currency). Accepted as given; real NetSuite would check
 * that the ID exists.
 */
const ListRef = z.strictObject({
  id: z.union([z.string().min(1), z.number()]).transform(String),
  refName: z.string().optional(),
});

const date = z.iso.date();
const amount = z.number().finite().positive();
const text = z.string().max(4000);

/** Fields every record may carry. */
const common = { memo: text.optional() };

// ---------------------------------------------------------------------------
// Schemas per record type
// ---------------------------------------------------------------------------

const customer = z.strictObject({
  ...common,
  companyName: z.string().min(1).max(250),
  email: z.email().optional(),
  phone: z.string().max(50).optional(),
});

const vendor = z.strictObject({
  ...common,
  companyName: z.string().min(1).max(250),
  email: z.email().optional(),
  phone: z.string().max(50).optional(),
});

const invoice = z.strictObject({
  ...common,
  entity: RecordRef,
  tranId: z.string().min(1).max(100).optional(),
  tranDate: date,
  dueDate: date.optional(),
  currency: ListRef,
  item: z.strictObject({
    items: z
      .array(
        z.strictObject({
          item: ListRef,
          description: text.optional(),
          quantity: z.number().finite().positive(),
          rate: z.number().finite().nonnegative(),
        }),
      )
      .min(1, 'An invoice needs at least one item line'),
  }),
});

const customerPayment = z.strictObject({
  ...common,
  customer: RecordRef,
  tranDate: date,
  currency: ListRef,
  payment: amount,
  paymentMethod: z.string().max(100).optional(),
  apply: z.strictObject({
    items: z
      .array(z.strictObject({ doc: RecordRef, amount }))
      .min(1, 'A payment must be applied to at least one invoice'),
  }),
});

const vendorBill = z.strictObject({
  ...common,
  entity: RecordRef,
  tranId: z.string().min(1).max(100).optional(),
  tranDate: date,
  dueDate: date.optional(),
  currency: ListRef,
  expense: z.strictObject({
    items: z
      .array(
        z.strictObject({
          account: ListRef,
          amount,
          memo: text.optional(),
        }),
      )
      .min(1, 'A vendor bill needs at least one expense line'),
  }),
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ReferenceField {
  /** Where the reference sits: "entity", or "apply.items[].doc" for a list. */
  path: string;
  target: RecordType;
}

export interface RecordTypeDef {
  schema: z.ZodType<Record<string, unknown>>;
  references: ReferenceField[];
  /** SuiteQL columns, besides id, externalId, createdDate, lastModifiedDate. */
  columns: string[];
  /** Name shown in references pointing at this record (refName). */
  refName: (fields: Record<string, unknown>) => string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const RECORD_TYPE_DEFS: Record<RecordType, RecordTypeDef> = {
  customer: {
    schema: customer,
    references: [],
    columns: ['companyName', 'email', 'phone', 'memo'],
    refName: (f) => str(f.companyName),
  },
  vendor: {
    schema: vendor,
    references: [],
    columns: ['companyName', 'email', 'phone', 'memo'],
    refName: (f) => str(f.companyName),
  },
  invoice: {
    schema: invoice,
    references: [{ path: 'entity', target: 'customer' }],
    columns: [
      'entity', 'tranId', 'tranDate', 'dueDate', 'currency', 'memo',
      'total', 'amountPaid', 'amountRemaining', 'status',
    ],
    refName: (f) => str(f.tranId),
  },
  customerPayment: {
    schema: customerPayment,
    references: [
      { path: 'customer', target: 'customer' },
      { path: 'apply.items[].doc', target: 'invoice' },
    ],
    columns: ['customer', 'tranDate', 'currency', 'payment', 'paymentMethod', 'memo', 'applied', 'unapplied'],
    refName: () => undefined,
  },
  vendorBill: {
    schema: vendorBill,
    references: [{ path: 'entity', target: 'vendor' }],
    columns: ['entity', 'tranId', 'tranDate', 'dueDate', 'currency', 'memo', 'total'],
    refName: (f) => str(f.tranId),
  },
};

/** Fields every record has, set by the ERP. */
export const SYSTEM_COLUMNS = ['id', 'externalId', 'createdDate', 'lastModifiedDate'] as const;

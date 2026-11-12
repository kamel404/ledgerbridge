import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NetSuiteError } from '../common/netsuite-error.js';
import { RECORD_STORE, type RecordStore, type StoredRecord } from './record-store.js';
import { RECORD_TYPE_DEFS, type RecordRef, type RecordType } from './record-types.js';
import { WriteLock } from './write-lock.js';

export interface UpsertResult {
  record: StoredRecord;
  created: boolean;
}

type Fields = Record<string, unknown>;

interface ApplyLine {
  invoiceId: string;
  amount: number;
}

/**
 * The mock ERP's record rules (SPEC §7.2):
 * - internal IDs are assigned here; externalId is unique per type,
 * - references accept { id } or { externalId } and must point at a real record,
 * - invoices track total / amountPaid / amountRemaining / status,
 * - a customerPayment updates the invoices it is applied to.
 */
@Injectable()
export class RecordsService {
  private readonly lock = new WriteLock();

  constructor(@Inject(RECORD_STORE) private readonly store: RecordStore) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getById(type: RecordType, id: string): Promise<StoredRecord> {
    const record = await this.store.get(type, id);
    if (!record) throw NetSuiteError.notFound(`Record ${type} with internal ID ${id} not found`);
    return record;
  }

  async getByExternalId(type: RecordType, externalId: string): Promise<StoredRecord> {
    const record = await this.store.getByExternalId(type, externalId);
    if (!record) throw NetSuiteError.notFound(`Record ${type} with external ID ${externalId} not found`);
    return record;
  }

  list(type: RecordType): Promise<StoredRecord[]> {
    return this.store.list(type);
  }

  // -------------------------------------------------------------------------
  // Writes (serialised, see WriteLock)
  // -------------------------------------------------------------------------

  /** POST /{type}. A duplicate externalId is a 400. */
  create(type: RecordType, body: unknown): Promise<StoredRecord> {
    return this.lock.run(async () => {
      const { externalId, fields } = splitBody(body);
      if (externalId && (await this.store.getByExternalId(type, externalId))) {
        throw NetSuiteError.badRequest(
          'DUPLICATE_EXTERNAL_ID',
          `A ${type} with external ID ${externalId} already exists`,
        );
      }
      return this.write(type, undefined, fields, externalId);
    });
  }

  /** PATCH /{type}/{id}. Only the fields sent are changed. */
  patch(type: RecordType, id: string, body: unknown): Promise<StoredRecord> {
    return this.lock.run(async () => {
      const existing = await this.getById(type, id);
      const { externalId, fields } = splitBody(body);
      if (externalId && externalId !== existing.externalId) {
        const other = await this.store.getByExternalId(type, externalId);
        if (other && other.id !== id) {
          throw NetSuiteError.badRequest(
            'DUPLICATE_EXTERNAL_ID',
            `A ${type} with external ID ${externalId} already exists`,
          );
        }
      }
      return this.write(type, existing, fields, externalId ?? existing.externalId);
    });
  }

  /**
   * PUT /{type}/eid:{externalId}: create if missing, update if present.
   * Sending the same body twice leaves exactly one record. This is what makes
   * retries safe for the integration.
   */
  upsert(type: RecordType, externalId: string, body: unknown): Promise<UpsertResult> {
    return this.lock.run(async () => {
      const { externalId: bodyExternalId, fields } = splitBody(body);
      if (bodyExternalId && bodyExternalId !== externalId) {
        throw NetSuiteError.badRequest(
          'INVALID_CONTENT',
          `externalId in the body (${bodyExternalId}) does not match the URL (${externalId})`,
        );
      }
      const existing = await this.store.getByExternalId(type, externalId);
      const record = await this.write(type, existing, fields, externalId);
      return { record, created: !existing };
    });
  }

  /** DELETE /{type}/{id}. Deleting a payment gives its amount back to the invoices. */
  delete(type: RecordType, id: string): Promise<void> {
    return this.lock.run(async () => {
      const existing = await this.getById(type, id);
      if (type === 'customerPayment') {
        const invoices = await this.reapply(applyLines(existing.fields), [], existing.fields);
        await this.store.save(invoices);
      }
      await this.store.delete(type, id);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async write(
    type: RecordType,
    existing: StoredRecord | undefined,
    changes: Fields,
    externalId: string | undefined,
  ): Promise<StoredRecord> {
    const def = RECORD_TYPE_DEFS[type];
    const merged = existing ? { ...existing.fields, ...changes } : changes;
    const fields = validate(def.schema, merged);
    await this.resolveReferences(type, fields);

    const now = new Date().toISOString();
    const record: StoredRecord = {
      type,
      id: existing?.id ?? (await this.store.nextId(type)),
      ...(externalId && { externalId }),
      fields,
      computed: {},
      createdDate: existing?.createdDate ?? now,
      lastModifiedDate: now,
      ...(existing?.version !== undefined && { version: existing.version }),
    };

    const alsoChanged = await this.applyBusinessRules(record, existing);
    await this.store.save([record, ...alsoChanged]);
    return record;
  }

  /** Replaces every reference with { id, externalId?, refName? }, or fails with INVALID_REFERENCE. */
  private async resolveReferences(type: RecordType, fields: Fields): Promise<void> {
    for (const { path, target } of RECORD_TYPE_DEFS[type].references) {
      for (const slot of refSlots(fields, path)) {
        const { ref } = slot;
        const found = ref.id
          ? await this.store.get(target, ref.id)
          : await this.store.getByExternalId(target, ref.externalId!);
        if (!found) {
          throw NetSuiteError.badRequest(
            'INVALID_REFERENCE',
            `Invalid reference: ${target} ${ref.externalId ?? ref.id} (field ${path.replace('[]', '')})`,
          );
        }
        const refName = RECORD_TYPE_DEFS[target].refName(found.fields);
        slot.set({
          id: found.id,
          ...(found.externalId && { externalId: found.externalId }),
          ...(refName && { refName }),
        });
      }
    }
  }

  /** Sets computed fields. Returns other records this write changed. */
  private async applyBusinessRules(
    record: StoredRecord,
    existing: StoredRecord | undefined,
  ): Promise<StoredRecord[]> {
    switch (record.type) {
      case 'invoice': {
        const lines = (record.fields.item as { items: { quantity: number; rate: number }[] }).items;
        const total = round2(lines.reduce((sum, l) => sum + l.quantity * l.rate, 0));
        const amountPaid = (existing?.computed.amountPaid as number | undefined) ?? 0;
        if (total < amountPaid) {
          throw NetSuiteError.badRequest(
            'INVALID_AMOUNT',
            `Invoice total ${total} would be less than the ${amountPaid} already paid`,
          );
        }
        record.computed = invoiceAmounts(total, amountPaid);
        return [];
      }
      case 'vendorBill': {
        const lines = (record.fields.expense as { items: { amount: number }[] }).items;
        record.computed = { total: round2(lines.reduce((sum, l) => sum + l.amount, 0)) };
        return [];
      }
      case 'customerPayment': {
        const payment = record.fields.payment as number;
        const lines = applyLines(record.fields);
        const applied = round2(lines.reduce((sum, l) => sum + l.amount, 0));
        if (applied > payment) {
          throw NetSuiteError.badRequest(
            'INVALID_AMOUNT',
            `Applied amount ${applied} exceeds the payment amount ${payment}`,
          );
        }
        record.computed = { applied, unapplied: round2(payment - applied) };
        const previous = existing ? applyLines(existing.fields) : [];
        return this.reapply(previous, lines, record.fields);
      }
      default:
        return [];
    }
  }

  /**
   * Moves a payment's amounts off the invoices it used to pay (`previous`) and
   * onto the invoices it pays now (`next`). Checks customer, currency and
   * remaining balance. Returns the changed invoices.
   */
  private async reapply(previous: ApplyLine[], next: ApplyLine[], payment: Fields): Promise<StoredRecord[]> {
    const delta = new Map<string, number>();
    for (const l of previous) delta.set(l.invoiceId, (delta.get(l.invoiceId) ?? 0) - l.amount);
    for (const l of next) delta.set(l.invoiceId, (delta.get(l.invoiceId) ?? 0) + l.amount);

    const nextIds = new Set(next.map((l) => l.invoiceId));
    const customerId = (payment.customer as RecordRef | undefined)?.id;
    const currencyId = (payment.currency as { id: string } | undefined)?.id;
    const changed: StoredRecord[] = [];

    for (const [invoiceId, change] of delta) {
      const invoice = await this.store.get('invoice', invoiceId);
      if (!invoice) continue; // invoice deleted since; nothing to give back
      const label = invoice.externalId ?? invoice.id;

      if (nextIds.has(invoiceId)) {
        if ((invoice.fields.entity as RecordRef).id !== customerId) {
          throw NetSuiteError.badRequest(
            'INVALID_REFERENCE',
            `Invoice ${label} belongs to a different customer than the payment`,
          );
        }
        const invoiceCurrency = (invoice.fields.currency as { id: string }).id;
        if (invoiceCurrency !== currencyId) {
          throw NetSuiteError.badRequest(
            'INVALID_CONTENT',
            `Payment currency ${currencyId} does not match invoice ${label} currency ${invoiceCurrency}`,
          );
        }
      }

      const total = invoice.computed.total as number;
      const amountPaid = round2((invoice.computed.amountPaid as number) + change);
      if (amountPaid > total) {
        const remaining = invoice.computed.amountRemaining as number;
        throw NetSuiteError.badRequest(
          'INVALID_AMOUNT',
          `Payment of ${round2(change)} exceeds the remaining balance ${remaining} of invoice ${label}`,
        );
      }
      invoice.computed = invoiceAmounts(total, Math.max(0, amountPaid));
      invoice.lastModifiedDate = new Date().toISOString();
      changed.push(invoice);
    }
    return changed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function invoiceAmounts(total: number, amountPaid: number): Fields {
  const amountRemaining = round2(total - amountPaid);
  return {
    total,
    amountPaid,
    amountRemaining,
    status: amountRemaining <= 0 ? 'paidInFull' : 'open',
  };
}

function applyLines(fields: Fields): ApplyLine[] {
  const items = (fields.apply as { items?: { doc: RecordRef; amount: number }[] } | undefined)?.items ?? [];
  return items.map((i) => ({ invoiceId: i.doc.id!, amount: i.amount }));
}

/** Splits `externalId` (handled by the service) from the record fields (validated by the schema). */
function splitBody(body: unknown): { externalId?: string; fields: Fields } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw NetSuiteError.badRequest('INVALID_CONTENT', 'The request body must be a JSON object');
  }
  const { externalId, ...fields } = body as Fields;
  if (externalId !== undefined && (typeof externalId !== 'string' || externalId.length === 0)) {
    throw NetSuiteError.badRequest('INVALID_CONTENT', 'externalId must be a non-empty string');
  }
  return { externalId: externalId as string | undefined, fields };
}

function validate(schema: z.ZodType<Fields>, input: unknown): Fields {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`)
    .join('; ');
  throw NetSuiteError.badRequest('INVALID_CONTENT', detail);
}

interface RefSlot {
  ref: RecordRef;
  set(value: RecordRef): void;
}

/** Finds the references at a path like "entity" or "apply.items[].doc". */
function refSlots(node: unknown, path: string): RefSlot[] {
  if (typeof node !== 'object' || node === null) return [];
  const obj = node as Fields;
  const [head, ...rest] = path.split('.');
  const restPath = rest.join('.');

  if (head!.endsWith('[]')) {
    const list = obj[head!.slice(0, -2)];
    return Array.isArray(list) ? list.flatMap((el) => refSlots(el, restPath)) : [];
  }
  if (rest.length > 0) return refSlots(obj[head!], restPath);
  if (obj[head!] === undefined) return [];
  return [{ ref: obj[head!] as RecordRef, set: (value) => (obj[head!] = value) }];
}

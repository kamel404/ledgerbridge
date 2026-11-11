import { PermanentError } from '../errors/integration-errors.js';

/**
 * Lookup tables translating source-app codes into ERP internal IDs (SPEC §6.3).
 * Seeded in code for now. In a real deployment finance would maintain these,
 * and the IDs would come from the ERP account.
 *
 * A missing entry is a permanent error: retrying can't help until someone adds
 * the mapping, and the error code says which table to edit.
 */

/** Product SKU (billing app) -> ERP item ID. */
export const ITEM_IDS = {
  'PLAN-STARTER': '500',
  'PLAN-PRO': '501',
  'PLAN-ENTERPRISE': '502',
  'ADDON-SEATS': '510',
  'ADDON-STORAGE': '511',
  'SVC-ONBOARDING': '520',
} as const satisfies Record<string, string>;

/** Expense category (procurement app) -> ERP expense account ID. */
export const ACCOUNT_IDS = {
  OFFICE_SUPPLIES: '6110',
  SOFTWARE: '6120',
  TRAVEL: '6130',
  RENT: '6140',
  UTILITIES: '6150',
  PROFESSIONAL_SERVICES: '6160',
  MARKETING: '6170',
} as const satisfies Record<string, string>;

/** ISO currency code -> ERP currency ID. */
export const CURRENCY_IDS = {
  USD: '1',
  EUR: '2',
  GBP: '3',
  LBP: '4',
} as const satisfies Record<string, string>;

export type Sku = keyof typeof ITEM_IDS;
export type ExpenseCategory = keyof typeof ACCOUNT_IDS;
export type CurrencyCode = keyof typeof CURRENCY_IDS;

function lookup(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function itemIdForSku(sku: string): string {
  const id = lookup(ITEM_IDS, sku);
  if (!id) throw new PermanentError('UNKNOWN_SKU', `No ERP item is mapped to SKU '${sku}'`);
  return id;
}

export function accountIdForCategory(category: string): string {
  const id = lookup(ACCOUNT_IDS, category);
  if (!id) {
    throw new PermanentError(
      'UNKNOWN_EXPENSE_CATEGORY',
      `No ERP account is mapped to expense category '${category}'`,
    );
  }
  return id;
}

export function currencyIdForCode(code: string): string {
  const id = lookup(CURRENCY_IDS, code);
  if (!id) throw new PermanentError('UNKNOWN_CURRENCY', `No ERP currency is mapped to '${code}'`);
  return id;
}

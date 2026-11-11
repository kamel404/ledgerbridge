// Fake source apps (SPEC §12): sends signed webhooks to the integration service.
//
//   npm run simulate -- happy        10 invoices, their payments, 5 vendor bills,
//                                    then checks the results in the mock ERP
//
// More commands (duplicates, out-of-order, bad-signature, ...) arrive in Phase 4.
//
// Options:
//   --delay <ms>   pause between webhooks (default 200). Each event costs the
//                  ERP 2-3 requests and the mock allows 25/s; until the queue
//                  retries 429s (Phase 4), a burst would leave events RETRYING.
//
// Settings come from the repo-root .env (see .env.example):
//   INTEGRATION_URL (default http://localhost:$INTEGRATION_SERVICE_PORT)
//   ERP_BASE_URL, MOCK_ERP_CLIENT_ID, MOCK_ERP_CLIENT_SECRET   (for the check)
//   WEBHOOK_SECRET_BILLING, WEBHOOK_SECRET_PROCUREMENT
//
// Runs with plain `node` (Node 22.18+ strips the TypeScript types itself).

import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const INTEGRATION_URL = (env.INTEGRATION_URL ?? `http://localhost:${env.INTEGRATION_SERVICE_PORT ?? 3000}`).replace(/\/+$/, '');
const ERP_URL = (env.ERP_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

const args = process.argv.slice(2);
const delayArg = args.indexOf('--delay');
const DELAY_MS = delayArg >= 0 ? Number(args[delayArg + 1]) : 200;
if (!Number.isFinite(DELAY_MS) || DELAY_MS < 0) {
  console.error('--delay needs a number of milliseconds');
  process.exit(2);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Source = 'billing' | 'procurement';
type Json = Record<string, unknown>;

const SECRETS: Record<Source, string | undefined> = {
  billing: env.WEBHOOK_SECRET_BILLING,
  procurement: env.WEBHOOK_SECRET_PROCUREMENT,
};

// ---------------------------------------------------------------------------
// Signing and sending
// ---------------------------------------------------------------------------

/** The headers a source app sends: X-Timestamp and X-Signature = hex HMAC-SHA256(secret, "<ts>.<body>"). */
function signHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const ts = String(timestamp);
  const signature = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Signature': signature };
}

interface SendResult {
  status: number;
  body: Json;
}

async function send(source: Source, event: Json): Promise<SendResult> {
  const secret = SECRETS[source];
  if (!secret) throw new Error(`Set WEBHOOK_SECRET_${source.toUpperCase()} (see .env.example)`);
  const body = JSON.stringify(event);
  if (DELAY_MS > 0) await sleep(DELAY_MS);
  const res = await fetch(`${INTEGRATION_URL}/webhooks/${source}`, {
    method: 'POST',
    headers: signHeaders(secret, body),
    body,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

/** A short unique prefix per run, so every run creates new records. */
const RUN = Date.now().toString(36).toUpperCase();
const today = new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
let eventCounter = 0;
const eventId = () => `evt_${RUN}_${String(++eventCounter).padStart(3, '0')}`;

// One customer per invoice and one vendor per bill, so `happy` gives
// 10 customers / 10 invoices / 10 payments / 5 vendors / 5 bills.
const CUSTOMERS = [
  { name: 'Cedar Logistics SAL', email: 'ap@cedar.example' },
  { name: 'Byblos Analytics', email: 'finance@byblos.example' },
  { name: 'Tyre Marine Services' },
  { name: 'Zahle Foods', email: 'billing@zahle.example' },
  { name: 'Jounieh Design Studio', email: 'accounts@jounieh.example' },
  { name: 'Batroun Wineries' },
  { name: 'Sidon Soap Works', email: 'ap@sidon.example' },
  { name: 'Baalbek Tours' },
  { name: 'Tripoli Textiles', email: 'finance@tripoli.example' },
  { name: 'Anjar Robotics', email: 'billing@anjar.example' },
];
const PLANS = [
  { sku: 'PLAN-STARTER', description: 'Starter plan, monthly', unitPrice: 19 },
  { sku: 'PLAN-PRO', description: 'Pro plan, monthly', unitPrice: 49 },
  { sku: 'PLAN-ENTERPRISE', description: 'Enterprise plan, monthly', unitPrice: 199 },
];
const ADDONS = [
  { sku: 'ADDON-SEATS', description: 'Extra seats', unitPrice: 5 },
  { sku: 'ADDON-STORAGE', description: 'Extra storage, 100 GB', unitPrice: 12.5 },
  { sku: 'SVC-ONBOARDING', description: 'Onboarding session', unitPrice: 150 },
];
const VENDORS = [
  'Beirut Office Supplies',
  'Mount Lebanon Telecom',
  'Phoenicia Travel',
  'Litani Power & Water',
  'Corniche Legal Partners',
];
const CATEGORIES = ['OFFICE_SUPPLIES', 'SOFTWARE', 'TRAVEL', 'UTILITIES', 'PROFESSIONAL_SERVICES'];

interface Invoice {
  event: Json;
  invoiceId: string;
  customerId: string;
  total: number;
}

function makeInvoice(i: number): Invoice {
  const c = i % CUSTOMERS.length;
  const customerId = `CUS-${RUN}-${c + 1}`;
  const invoiceId = `INV-${RUN}-${String(i + 1).padStart(2, '0')}`;
  const plan = PLANS[i % PLANS.length]!;
  const lines: Json[] = [{ ...plan, quantity: 1 + (i % 3) }];
  if (i % 2 === 1) lines.push({ ...ADDONS[i % ADDONS.length]!, quantity: 2 });
  const total = round2(lines.reduce((s, l) => s + (l.quantity as number) * (l.unitPrice as number), 0));
  return {
    invoiceId,
    customerId,
    total,
    event: {
      id: eventId(),
      type: 'invoice.created',
      occurredAt: nowIso(),
      data: {
        invoiceId,
        customer: { id: customerId, ...CUSTOMERS[c]! },
        issueDate: today,
        dueDate: inDays(30),
        currency: 'USD',
        lines,
      },
    },
  };
}

function makePayment(inv: Invoice, i: number): Json {
  return {
    id: eventId(),
    type: 'payment.received',
    occurredAt: nowIso(),
    data: {
      paymentId: `PAY-${RUN}-${String(i + 1).padStart(2, '0')}`,
      invoiceId: inv.invoiceId,
      customerId: inv.customerId,
      amount: inv.total,
      currency: 'USD',
      method: i % 2 ? 'card' : 'bank_transfer',
      receivedDate: today,
    },
  };
}

function makeBill(i: number): { event: Json; billNumber: string } {
  const billNumber = `BILL-${RUN}-${i + 1}`;
  const v = i % VENDORS.length;
  const lines: Json[] = [
    { expenseCategory: CATEGORIES[i % CATEGORIES.length], description: 'Monthly charge', amount: 100 + i * 40 },
  ];
  if (i % 2 === 0) lines.push({ expenseCategory: 'OFFICE_SUPPLIES', description: 'Printer paper', amount: 24.5 });
  return {
    billNumber,
    event: {
      id: eventId(),
      type: 'bill.approved',
      occurredAt: nowIso(),
      data: {
        billNumber,
        vendor: { id: `VEN-${RUN}-${v + 1}`, name: VENDORS[v] },
        billDate: today,
        dueDate: inDays(30),
        currency: 'USD',
        lines,
      },
    },
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Checking results in the mock ERP
// ---------------------------------------------------------------------------

/** fetch that waits and tries again when the mock ERP rate-limits us (429 + Retry-After). */
async function erpFetch(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt === 5) return res;
    await sleep(Number(res.headers.get('retry-after') ?? 1) * 1000);
  }
}

async function erpToken(): Promise<string> {
  const res = await erpFetch(`${ERP_URL}/services/rest/auth/oauth2/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MOCK_ERP_CLIENT_ID ?? 'local-client',
      client_secret: env.MOCK_ERP_CLIENT_SECRET ?? 'local-dev-secret-change-me',
    }),
  });
  if (!res.ok) throw new Error(`ERP token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function erpGet(token: string, type: string, externalId: string): Promise<Json | undefined> {
  const res = await erpFetch(`${ERP_URL}/services/rest/record/v1/${type}/eid:${encodeURIComponent(externalId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`ERP GET ${type} ${externalId} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Json;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function report(label: string, results: SendResult[]): boolean {
  const byOutcome = new Map<string, number>();
  for (const r of results) {
    const key = `${r.status} ${String(r.body.status ?? r.body.error ?? '')}`.trim();
    byOutcome.set(key, (byOutcome.get(key) ?? 0) + 1);
  }
  const summary = [...byOutcome].map(([k, n]) => `${n} x ${k}`).join(', ');
  const ok = results.every((r) => r.status === 202 && r.body.status === 'SUCCEEDED');
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(9)} ${summary}`);
  for (const r of results.filter((x) => !(x.status === 202 && x.body.status === 'SUCCEEDED'))) {
    console.log(`         ${JSON.stringify(r.body)}`);
  }
  return ok;
}

async function happy(): Promise<boolean> {
  console.log(`Run ${RUN}: sending to ${INTEGRATION_URL}`);
  const invoices = Array.from({ length: 10 }, (_, i) => makeInvoice(i));
  const bills = Array.from({ length: 5 }, (_, i) => makeBill(i));

  // In order: payments need their invoice to exist (out-of-order is Phase 4).
  const sent = {
    invoices: [] as SendResult[],
    payments: [] as SendResult[],
    bills: [] as SendResult[],
  };
  for (const inv of invoices) sent.invoices.push(await send('billing', inv.event));
  for (const [i, inv] of invoices.entries()) sent.payments.push(await send('billing', makePayment(inv, i)));
  for (const bill of bills) sent.bills.push(await send('procurement', bill.event));

  let ok = report('invoices', sent.invoices);
  ok = report('payments', sent.payments) && ok;
  ok = report('bills', sent.bills) && ok;

  console.log(`Checking the ERP at ${ERP_URL}`);
  const token = await erpToken();
  const problems: string[] = [];
  const customerIds = new Set(invoices.map((i) => i.customerId));
  for (const id of customerIds) if (!(await erpGet(token, 'customer', id))) problems.push(`customer ${id} missing`);
  for (const inv of invoices) {
    const record = await erpGet(token, 'invoice', inv.invoiceId);
    if (!record) problems.push(`invoice ${inv.invoiceId} missing`);
    else if (record.status !== 'paidInFull') {
      problems.push(`invoice ${inv.invoiceId} is ${String(record.status)}, remaining ${String(record.amountRemaining)}`);
    }
  }
  const vendorIds = new Set(bills.map((b) => (b.event.data as { vendor: { id: string } }).vendor.id));
  for (const id of vendorIds) if (!(await erpGet(token, 'vendor', id))) problems.push(`vendor ${id} missing`);
  for (const bill of bills) {
    if (!(await erpGet(token, 'vendorBill', bill.billNumber))) problems.push(`vendor bill ${bill.billNumber} missing`);
  }

  console.log(
    `  ${problems.length ? 'FAIL' : 'ok  '} ${customerIds.size} customers, ${invoices.length} invoices (all paidInFull), ` +
      `${invoices.length} payments, ${vendorIds.size} vendors, ${bills.length} vendor bills`,
  );
  for (const p of problems) console.log(`         ${p}`);
  return ok && problems.length === 0;
}

const COMMANDS: Record<string, () => Promise<boolean>> = { happy };

const command = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--delay');
const run = command ? COMMANDS[command] : undefined;
if (!run) {
  console.error(`Usage: npm run simulate -- <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}
try {
  const ok = await run();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof TypeError && String(err.cause ?? '').includes('ECONNREFUSED')) {
    console.error('Is the integration service (and the mock ERP) running?');
  }
  process.exit(1);
}

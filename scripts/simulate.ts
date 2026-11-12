// Fake source apps (SPEC §12): sends signed webhooks to the integration service.
//
//   npm run simulate -- happy             10 invoices, their payments, 5 vendor bills,
//                                         then checks the results in the mock ERP
//   npm run simulate -- one               one invoice event; prints the response
//   npm run simulate -- duplicates        the same event 3 times (+ once more with a new
//                                         event ID): one sync record, one ERP record
//   npm run simulate -- out-of-order      a payment before its invoice: retried until it
//                                         succeeds (needs the queue, so use --aws)
//   npm run simulate -- bad-signature     wrong secret, old timestamp -> 401, nothing logged
//   npm run simulate -- bad-payload       schema failure, broken JSON, wrong route -> 400 REJECTED
//   npm run simulate -- unknown-category  a bill with an unmapped category -> FAILED, not retried
//   npm run simulate -- dead --aws        a payment whose invoice never comes: 4 failed tries,
//                                         dead-letter queue, status DEAD (takes ~4 minutes)
//   npm run simulate -- csv --aws         uploads a vendor-bill CSV with some bad rows to the
//                                         import bucket; checks the bills, the errors file,
//                                         then uploads it again (nothing new may appear)
//
// Options:
//   --aws          send to the deployed AWS API instead of localhost. The URLs
//                  come from infra/cdk-outputs.json (written by `npm run deploy`)
//                  and the secrets from .env.aws (`npm run aws:secrets`).
//                  The 202 reply only means "queued", so the simulator then
//                  reads the SyncLog table (AWS CLI, profile ledgerbridge)
//                  until each event reaches its final status.
//   --delay <ms>   pause between webhooks (default 200). Locally there's no
//                  queue, so a burst would hit the mock ERP's 25 requests/s
//                  limit and leave events RETRYING.
//
// Local settings come from the repo-root .env (see .env.example):
//   INTEGRATION_URL (default http://localhost:$INTEGRATION_SERVICE_PORT)
//   ERP_BASE_URL, MOCK_ERP_CLIENT_ID, MOCK_ERP_CLIENT_SECRET   (for the check)
//   WEBHOOK_SECRET_BILLING, WEBHOOK_SECRET_PROCUREMENT
//
// Runs with plain `node` (Node 22.18+ strips the TypeScript types itself).

import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws, loginHint } from './aws-cli.ts';

const args = process.argv.slice(2);
const ON_AWS = args.includes('--aws');

const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const envFile = repoFile(ON_AWS ? '.env.aws' : '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
else if (ON_AWS) {
  console.error('.env.aws is missing. Run `npm run aws:secrets` first.');
  process.exit(2);
}

/** URLs and names of the deployed stacks, from `cdk deploy --outputs-file`. */
function awsOutputs(): { apiUrl: string; erpUrl: string; tableName: string; csvBucket: string } {
  const file = repoFile('infra/cdk-outputs.json');
  if (!existsSync(file)) {
    console.error('infra/cdk-outputs.json is missing. Run `npm run deploy` first.');
    process.exit(2);
  }
  const outputs = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
  const lb = outputs.LedgerBridgeStack ?? {};
  return {
    apiUrl: lb.ApiUrl ?? '',
    erpUrl: outputs.MockErpStack?.MockErpUrl ?? '',
    tableName: lb.SyncLogTableName ?? '',
    csvBucket: lb.CsvBucketName ?? '',
  };
}

const env = process.env;
const deployed = ON_AWS ? awsOutputs() : undefined;
const INTEGRATION_URL = (
  deployed?.apiUrl ?? env.INTEGRATION_URL ?? `http://localhost:${env.INTEGRATION_SERVICE_PORT ?? 3000}`
).replace(/\/+$/, '');
const ERP_URL = (deployed?.erpUrl ?? env.ERP_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

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

interface SendOptions {
  /** Sign with this secret instead of the source's real one. */
  secret?: string;
  /** X-Timestamp in unix seconds (default: now). */
  timestamp?: number;
  /** Send this exact text instead of JSON.stringify(event). */
  raw?: string;
}

async function send(source: Source, event: Json, opts: SendOptions = {}): Promise<SendResult> {
  const secret = opts.secret ?? SECRETS[source];
  if (!secret) throw new Error(`Set WEBHOOK_SECRET_${source.toUpperCase()} (see .env.example)`);
  const body = opts.raw ?? JSON.stringify(event);
  if (DELAY_MS > 0) await sleep(DELAY_MS);
  const res = await fetch(`${INTEGRATION_URL}/webhooks/${source}`, {
    method: 'POST',
    headers: signHeaders(secret, body, opts.timestamp),
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

/** How many ERP records of this type have this external ID (SuiteQL). Should never be more than 1. */
async function erpCount(token: string, type: string, externalId: string): Promise<number> {
  const res = await erpFetch(`${ERP_URL}/services/rest/query/v1/suiteql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Prefer: 'transient', 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: `SELECT id FROM ${type} WHERE externalId = '${externalId}'` }),
  });
  if (!res.ok) throw new Error(`SuiteQL failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { totalResults: number }).totalResults;
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

interface SyncState {
  status: string;
  attempts?: number;
  error?: string;
}

const FINAL = new Set(['SUCCEEDED', 'FAILED', 'DEAD', 'REJECTED']);

type DynamoValue = { S?: string; N?: string; M?: Record<string, { S?: string }> };

/** Reads sync records straight from the SyncLog table (AWS only; there's no admin API until Phase 7). */
function readSyncLog(eventIds: string[]): Map<string, SyncState> {
  const found = new Map<string, SyncState>();
  for (let i = 0; i < eventIds.length; i += 100) {
    const request = {
      [deployed!.tableName]: {
        Keys: eventIds.slice(i, i + 100).map((id) => ({ eventId: { S: id } })),
        ConsistentRead: true,
        ProjectionExpression: 'eventId, #s, attempts, lastError',
        ExpressionAttributeNames: { '#s': 'status' },
      },
    };
    const out = JSON.parse(aws(['dynamodb', 'batch-get-item', '--request-items', JSON.stringify(request)])) as {
      Responses: Record<string, Array<Record<string, DynamoValue>>>;
    };
    for (const item of Object.values(out.Responses).flat()) {
      found.set(item.eventId!.S!, {
        status: item.status?.S ?? '?',
        attempts: Number(item.attempts?.N ?? 0),
        ...(item.lastError?.M?.code?.S && { error: item.lastError.M.code.S }),
      });
    }
  }
  return found;
}

/**
 * The final status of each event. Locally the worker runs inside the webhook
 * request, so the 202 reply already has it. On AWS the worker runs later, so
 * poll the SyncLog until every event is final (or the time runs out).
 */
async function settle(
  eventIds: string[],
  localReplies: Map<string, SendResult>,
  timeoutMs = 150_000,
): Promise<Map<string, SyncState>> {
  if (!ON_AWS) {
    return new Map(eventIds.map((id) => [id, { status: String(localReplies.get(id)?.body.status ?? '?') }]));
  }
  const deadline = Date.now() + timeoutMs;
  let lastLine = '';
  for (;;) {
    const states = readSyncLog(eventIds);
    const pending = eventIds.filter((id) => !FINAL.has(states.get(id)?.status ?? ''));
    if (pending.length === 0 || Date.now() > deadline) return states;
    const waitingOn = [...new Set(pending.map((id) => states.get(id)?.status ?? 'not found'))].join(', ');
    const line = `  waiting for ${pending.length} of ${eventIds.length} events (${waitingOn})`;
    if (line !== lastLine) console.log(line);
    lastLine = line;
    await sleep(3000);
  }
}

/** Waits until one event has a given status (AWS), e.g. "the payment has failed once". */
async function waitForStatus(eventId: string, wanted: string, timeoutMs = 60_000): Promise<SyncState | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readSyncLog([eventId]).get(eventId);
    if (state?.status === wanted) return state;
    await sleep(1000);
  }
  return undefined;
}

const describeState = (s?: SyncState) =>
  s ? [s.status, s.attempts ? `attempts ${s.attempts}` : '', s.error ?? ''].filter(Boolean).join(', ') : 'no sync record';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Prints one check line. */
function check(ok: boolean, label: string, detail = ''): boolean {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  return ok;
}

/** Sends the events in order, then waits for their final status. */
async function sendAndSettle(items: Array<{ source: Source; event: Json }>): Promise<Map<string, SyncState>> {
  const replies = new Map<string, SendResult>();
  for (const { source, event } of items) {
    const res = await send(source, event);
    replies.set(String(event.id), res);
    if (res.status !== 202) console.log(`  unexpected ${res.status} for ${String(event.id)}: ${JSON.stringify(res.body)}`);
  }
  return settle([...replies.keys()], replies);
}

function reportGroup(label: string, ids: string[], states: Map<string, SyncState>): boolean {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const st = states.get(id)?.status ?? 'missing';
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  const ok = ids.every((id) => states.get(id)?.status === 'SUCCEEDED');
  check(ok, label.padEnd(9), [...counts].map(([k, n]) => `${n} x ${k}`).join(', '));
  for (const id of ids.filter((x) => states.get(x)?.status !== 'SUCCEEDED')) {
    console.log(`         ${id}: ${describeState(states.get(id))}`);
  }
  return ok;
}

async function happy(): Promise<boolean> {
  console.log(`Run ${RUN}: sending to ${INTEGRATION_URL}`);
  const invoices = Array.from({ length: 10 }, (_, i) => makeInvoice(i));
  const payments = invoices.map((inv, i) => makePayment(inv, i));
  const bills = Array.from({ length: 5 }, (_, i) => makeBill(i));

  const states = await sendAndSettle([
    ...invoices.map((inv) => ({ source: 'billing' as const, event: inv.event })),
    ...payments.map((event) => ({ source: 'billing' as const, event })),
    ...bills.map((b) => ({ source: 'procurement' as const, event: b.event })),
  ]);
  let ok = reportGroup('invoices', invoices.map((i) => String(i.event.id)), states);
  ok = reportGroup('payments', payments.map((p) => String(p.id)), states) && ok;
  ok = reportGroup('bills', bills.map((b) => String(b.event.id)), states) && ok;

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

  check(
    problems.length === 0,
    `${customerIds.size} customers, ${invoices.length} invoices (all paidInFull), ` +
      `${invoices.length} payments, ${vendorIds.size} vendors, ${bills.length} vendor bills`,
  );
  for (const p of problems) console.log(`         ${p}`);
  return ok && problems.length === 0;
}

/** Sends one invoice event. On AWS the expected answer is 202 { syncId }: queued. */
async function one(): Promise<boolean> {
  const inv = makeInvoice(0);
  console.log(`Sending ${String(inv.event.type)} ${inv.invoiceId} (event ${String(inv.event.id)}) to ${INTEGRATION_URL}`);
  const res = await send('billing', inv.event);
  console.log(`  ${res.status} ${JSON.stringify(res.body)}`);
  return res.status === 202;
}

/**
 * Both idempotency layers (SPEC §8.3):
 * - event level: the same event ID 3 times -> 202 once, then 200 duplicate
 * - record level: the same invoice under a new event ID -> processed again,
 *   but it's an upsert by external ID, so still one ERP record
 */
async function duplicates(): Promise<boolean> {
  const inv = makeInvoice(0);
  const id = String(inv.event.id);
  console.log(`Sending invoice ${inv.invoiceId} (event ${id}) 3 times to ${INTEGRATION_URL}`);
  const replies: SendResult[] = [];
  for (let i = 0; i < 3; i++) replies.push(await send('billing', inv.event));
  let ok = check(
    replies[0]!.status === 202 && replies.slice(1).every((r) => r.status === 200 && r.body.duplicate === true),
    'event level',
    replies.map((r) => `${r.status}${r.body.duplicate ? ' duplicate' : ''}`).join(', '),
  );

  const again = { ...inv.event, id: eventId() };
  const againId = String(again.id);
  const againReply = await send('billing', again);
  ok = check(againReply.status === 202, 'same invoice, new event ID', `${againReply.status} (accepted: it's a different event)`) && ok;

  const states = await settle([id, againId], new Map([[id, replies[0]!], [againId, againReply]]));
  ok = check(states.get(id)?.status === 'SUCCEEDED', `event ${id}`, describeState(states.get(id))) && ok;
  ok = check(states.get(againId)?.status === 'SUCCEEDED', `event ${againId}`, describeState(states.get(againId))) && ok;

  const token = await erpToken();
  const count = await erpCount(token, 'invoice', inv.invoiceId);
  return check(count === 1, 'record level', `${count} invoice record(s) with external ID ${inv.invoiceId} in the ERP`) && ok;
}

/** A payment that arrives before its invoice (SPEC §8.2: "dependency not yet present" is retryable). */
async function outOfOrder(): Promise<boolean> {
  const inv = makeInvoice(0);
  const payment = makePayment(inv, 0);
  const paymentId = String((payment.data as Json).paymentId);
  const payId = String(payment.id);
  const invId = String(inv.event.id);
  console.log(`Sending payment ${paymentId} BEFORE invoice ${inv.invoiceId} to ${INTEGRATION_URL}`);

  const payReply = await send('billing', payment);
  if (!ON_AWS) {
    check(payReply.body.status === 'RETRYING', 'payment first', String(payReply.body.status));
    console.log('         Locally there is no queue to retry it, so it stays RETRYING. Run with --aws to see the retry.');
    console.log('         (A local automated version: npm run test:e2e -w integration-service, worker.e2e-spec.ts)');
    return false;
  }
  // Wait until the worker has tried the payment and found no invoice, so the order is really "payment first".
  const first = await waitForStatus(payId, 'RETRYING');
  let ok = check(first?.error === 'INVOICE_NOT_FOUND', 'payment tried first', describeState(first));

  const invReply = await send('billing', inv.event);
  console.log(`  invoice sent (${invReply.status}); the payment comes back about 10 s after its failed try`);

  const states = await settle([invId, payId], new Map());
  ok = check(states.get(invId)?.status === 'SUCCEEDED', 'invoice', describeState(states.get(invId))) && ok;
  const pay = states.get(payId);
  ok = check(pay?.status === 'SUCCEEDED' && (pay.attempts ?? 0) > 1, 'payment', describeState(pay)) && ok;

  const token = await erpToken();
  const record = await erpGet(token, 'invoice', inv.invoiceId);
  ok = check(record?.status === 'paidInFull', 'invoice in the ERP', String(record?.status ?? 'missing')) && ok;
  const count = await erpCount(token, 'customerPayment', paymentId);
  return check(count === 1, 'payments in the ERP', String(count)) && ok;
}

/** Requests that must be refused before anything is logged. */
async function badSignature(): Promise<boolean> {
  const inv = makeInvoice(0);
  console.log(`Sending badly signed webhooks to ${INTEGRATION_URL}`);
  const wrong = await send('billing', inv.event, { secret: 'not-the-real-secret' });
  let ok = check(wrong.status === 401, 'wrong secret', String(wrong.status));
  const old = await send('billing', inv.event, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  ok = check(old.status === 401, 'timestamp 10 minutes old', String(old.status)) && ok;
  const swapped = await send('procurement', inv.event, { secret: SECRETS.billing });
  ok = check(swapped.status === 401, "signed with the other source's secret", String(swapped.status)) && ok;

  // Nothing was logged, so the event ID is still unused: sent properly now it must be 202, not "200 duplicate".
  const good = await send('billing', inv.event);
  return check(good.status === 202, 'same event correctly signed', `${good.status} (nothing was logged before)`) && ok;
}

/** Bodies that are signed correctly but aren't valid events. */
async function badPayload(): Promise<boolean> {
  console.log(`Sending invalid payloads to ${INTEGRATION_URL}`);
  const inv = makeInvoice(0);
  const noLines = { ...inv.event, data: { ...(inv.event.data as Json), lines: undefined } };
  const schema = await send('billing', noLines);
  let ok = check(schema.status === 400 && schema.body.error === 'INVALID_PAYLOAD', 'missing lines', `${schema.status} ${String(schema.body.error)}`);
  const broken = await send('billing', {}, { raw: '{"id": "evt_broken", "type": ' });
  ok = check(broken.status === 400 && broken.body.error === 'INVALID_JSON', 'not JSON', `${broken.status} ${String(broken.body.error)}`) && ok;
  const wrongRoute = await send('procurement', makeInvoice(1).event);
  ok = check(
    wrongRoute.status === 400 && wrongRoute.body.error === 'WRONG_SOURCE',
    'invoice sent to /procurement',
    `${wrongRoute.status} ${String(wrongRoute.body.error)}`,
  ) && ok;
  if (ON_AWS) {
    const ids = [schema, broken, wrongRoute].map((r) => String(r.body.syncId));
    const states = readSyncLog(ids);
    ok = check(
      ids.every((id) => states.get(id)?.status === 'REJECTED'),
      'logged as REJECTED',
      ids.map((id) => describeState(states.get(id))).join(' | '),
    ) && ok;
  }
  return ok;
}

/** A bill whose expense category has no ERP account: permanent, so FAILED after one try. */
async function unknownCategory(): Promise<boolean> {
  const bill = makeBill(0);
  const data = bill.event.data as Json;
  data.lines = [{ expenseCategory: 'YACHTS', description: 'Team offsite', amount: 9000 }];
  const id = String(bill.event.id);
  console.log(`Sending bill ${bill.billNumber} with expense category YACHTS to ${INTEGRATION_URL}`);
  const reply = await send('procurement', bill.event);
  let ok = check(reply.status === 202, 'accepted', String(reply.status));
  const state = (await settle([id], new Map([[id, reply]]))).get(id);
  ok = check(state?.status === 'FAILED' && (!ON_AWS || state.attempts === 1), 'failed permanently, not retried', describeState(state)) && ok;
  if (ON_AWS) ok = check(state?.error === 'UNKNOWN_EXPENSE_CATEGORY', 'error code', String(state?.error)) && ok;
  const token = await erpToken();
  const vendor = await erpGet(token, 'vendor', String((data.vendor as Json).id));
  return check(!vendor, 'nothing written to the ERP', vendor ? 'vendor was created!' : 'no vendor, no bill') && ok;
}

/**
 * A payment for an invoice that never arrives: retryable every time, so after
 * 4 receives (retry delays 10 s, 30 s, 90 s, 90 s) SQS moves it to the DLQ and
 * the DLQ Lambda marks it DEAD.
 */
async function dead(): Promise<boolean> {
  if (!ON_AWS) {
    console.error('Needs the queue and the DLQ, so use --aws.');
    return false;
  }
  const inv = makeInvoice(0); // never sent
  const payment = makePayment(inv, 0);
  const id = String(payment.id);
  console.log(`Sending payment ${String((payment.data as Json).paymentId)} for invoice ${inv.invoiceId}, which never comes`);
  const reply = await send('billing', payment);
  let ok = check(reply.status === 202, 'accepted', String(reply.status));
  console.log('  it is retried after 10 s, 30 s, 90 s and 90 s, then moves to the DLQ (about 4 minutes)');
  const state = (await settle([id], new Map(), 8 * 60_000)).get(id);
  ok = check(state?.status === 'DEAD' && state.attempts === 4, 'marked DEAD', describeState(state)) && ok;
  return ok;
}

// ---------------------------------------------------------------------------
// CSV import (AWS only: the import is triggered by S3)
// ---------------------------------------------------------------------------

/** True once the S3 object exists. */
function s3Exists(key: string): boolean {
  try {
    aws(['s3api', 'head-object', '--bucket', deployed!.csvBucket, '--key', key]);
    return true;
  } catch (err) {
    if (/Not Found|404/.test(String((err as { stderr?: string }).stderr))) return false;
    throw err;
  }
}

/** Uploads text to incoming/<name> and waits until the CSV Lambda has moved it away. */
async function uploadCsv(name: string, text: string, timeoutMs = 90_000): Promise<boolean> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-csv-'));
  try {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    aws(['s3', 'cp', file, `s3://${deployed!.csvBucket}/incoming/${name}`, '--only-show-errors']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (!s3Exists(`incoming/${name}`)) return true;
  }
  return false;
}

function s3Text(key: string): string | undefined {
  if (!s3Exists(key)) return undefined;
  return aws(['s3', 'cp', `s3://${deployed!.csvBucket}/${key}`, '-']);
}

/**
 * Upload a CSV of vendor bills with some invalid rows (SPEC §12 `csv`):
 *   3 valid bills (one of them with 2 lines), and 5 bad rows: bad date,
 *   missing amount, unknown category, and a bill with one good + one bad row
 *   (rejected as a whole, so it can't arrive with the wrong total).
 */
async function csv(): Promise<boolean> {
  if (!ON_AWS) {
    console.error('The CSV import is triggered by S3, so this needs --aws.');
    console.error('(Locally, the import logic is covered by: npm test -w integration-service)');
    return false;
  }
  if (!deployed!.csvBucket) {
    console.error('No CsvBucketName in infra/cdk-outputs.json. Run `npm run deploy` first.');
    return false;
  }
  const b = (n: number) => `BILL-${RUN}-C${n}`;
  const v = (n: number) => `VEN-${RUN}-C${n}`;
  const text = [
    'bill_number,vendor_id,vendor_name,bill_date,due_date,currency,expense_category,description,amount',
    `${b(1)},${v(1)},Beirut Office Supplies,${today},${inDays(30)},USD,OFFICE_SUPPLIES,Printer paper,24.50`,
    `${b(1)},${v(1)},Beirut Office Supplies,${today},${inDays(30)},USD,SOFTWARE,"Licences, annual",1200`,
    `${b(2)},${v(2)},Mount Lebanon Telecom,${today},,USD,UTILITIES,Fibre line,89.99`,
    `${b(3)},${v(3)},Phoenicia Travel,${today},${inDays(15)},EUR,TRAVEL,Flights to Paris,640`,
    `${b(4)},${v(4)},Litani Power & Water,2026-13-45,,USD,UTILITIES,Electricity,310`,
    `${b(5)},${v(5)},Corniche Legal Partners,${today},,USD,PROFESSIONAL_SERVICES,Contract review,`,
    `${b(6)},${v(6)},Marina Yachts,${today},,USD,YACHTS,Team offsite,9000`,
    `${b(7)},${v(7)},Cedar Cleaning,${today},,USD,OFFICE_SUPPLIES,Cleaning products,45`,
    `${b(7)},${v(7)},Cedar Cleaning,${today},,USD,OFFICE_SUPPLIES,Refund,-20`,
    '',
  ].join('\n');
  const hash = createHash('sha256').update(text).digest('hex');
  const name = `bills-${RUN}.csv`;
  const validBills = [b(1), b(2), b(3)];
  const invalidBills = [b(4), b(5), b(6), b(7)];
  const ids = validBills.map((n) => `csv:${hash}:${n}`);

  console.log(`Uploading ${name} (8 data rows: 3 good bills, 5 bad rows) to s3://${deployed!.csvBucket}/incoming/`);
  let ok = check(await uploadCsv(name, text), 'file picked up', `moved out of incoming/`);
  ok = check(s3Exists(`processed/${name}`), 'file in processed/', `processed/${name}`) && ok;

  const errors = s3Text(`rejected/bills-${RUN}.errors.csv`);
  const errorLines = (errors ?? '').split(/\r?\n/).filter(Boolean).slice(1);
  ok = check(errorLines.length === 5, 'errors file', `rejected/bills-${RUN}.errors.csv with ${errorLines.length} row(s)`) && ok;
  for (const line of errorLines) console.log(`         ${line}`);

  const states = await settle(ids, new Map());
  ok = reportGroup('bills', ids, states) && ok;

  const token = await erpToken();
  const created = await Promise.all(validBills.map((n) => erpCount(token, 'vendorBill', n)));
  ok = check(created.every((c) => c === 1), 'valid bills in the ERP', created.join(', ')) && ok;
  const twoLines = await erpGet(token, 'vendorBill', b(1));
  const lines = (twoLines?.expense as { items?: unknown[] } | undefined)?.items?.length;
  ok = check(lines === 2, `${b(1)} has both lines`, `${String(lines)} line(s), total ${String(twoLines?.total)}`) && ok;
  const leaked = await Promise.all(invalidBills.map((n) => erpCount(token, 'vendorBill', n)));
  ok = check(leaked.every((c) => c === 0), 'invalid bills not in the ERP', leaked.join(', ')) && ok;

  console.log('Uploading the same file again');
  ok = check(await uploadCsv(name, text), 'file picked up again') && ok;
  await sleep(5000); // give any (wrongly) queued event time to be processed
  const again = readSyncLog(ids);
  ok = check(
    ids.every((id) => again.get(id)?.status === 'SUCCEEDED' && again.get(id)?.attempts === 1),
    'sync records unchanged',
    ids.map((id) => describeState(again.get(id))).join(' | '),
  ) && ok;
  const afterCounts = await Promise.all(validBills.map((n) => erpCount(token, 'vendorBill', n)));
  return check(afterCounts.every((c) => c === 1), 'still one record per bill in the ERP', afterCounts.join(', ')) && ok;
}

const COMMANDS: Record<string, () => Promise<boolean>> = {
  happy,
  one,
  duplicates,
  'out-of-order': outOfOrder,
  'bad-signature': badSignature,
  'bad-payload': badPayload,
  'unknown-category': unknownCategory,
  dead,
  csv,
};

const command = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--delay');
const run = command ? COMMANDS[command] : undefined;
if (!run) {
  console.error(`Usage: npm run simulate -- <${Object.keys(COMMANDS).join('|')}> [--aws] [--delay <ms>]`);
  process.exit(2);
}
try {
  const ok = await run();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  const hint = loginHint(err);
  if (hint) console.error(hint);
  if (err instanceof TypeError && String(err.cause ?? '').includes('ECONNREFUSED')) {
    console.error('Is the integration service (and the mock ERP) running?');
  }
  process.exit(1);
}

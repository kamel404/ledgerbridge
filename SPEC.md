# LedgerBridge — Technical Requirements

An integration hub that syncs a billing app and a procurement app into an ERP, built with NestJS on AWS, with a Next.js monitoring dashboard.

This file is the single source of truth for the build. Read sections 1–4 to understand what is being built and why. Sections 5–12 are the requirements. Section 13 is the build order.

---

## 1. Why this project exists

**Goal:** demonstrate the skills asked for in an "ERP / NetSuite Integration Developer" role, without access to a real NetSuite account.

The role is about connecting third-party business apps to NetSuite (an ERP) so finance data flows automatically and reliably. The hard parts of that job are not the HTTP calls. They are:

- mapping one system's data model to another's,
- never creating duplicates when something is retried,
- surviving failures (the ERP is down, data arrives out of order, a payload is malformed),
- knowing when something broke, and being able to fix and replay it,
- keeping credentials and access under control.

LedgerBridge is that job in miniature. Every feature below exists to show one of those abilities.

### Traceability: job requirement → project feature

| Job requirement | Where it is shown |
|---|---|
| Develop integrations that create, retrieve, update ERP records through APIs | Worker calling the NetSuite-shaped record API (§7, §8) |
| Order-to-Cash: connect billing, invoicing, payment apps | O2C flow (§6.1) |
| Procure-to-Pay: connect procurement, accounts payable, expense apps | P2P flow, webhook and CSV (§6.2) |
| Work with NetSuite APIs, records, SuiteQL, authentication | Mock ERP copies NetSuite's REST shape (§7) |
| Access and authentication controls for integrations | OAuth 2.0, HMAC signatures, Secrets Manager, IAM (§10) |
| Dashboards with visibility into activity, status, errors, failures | Next.js dashboard (§9) |
| Alerts and monitoring to identify issues | CloudWatch metrics, alarms, SNS (§11) |
| Troubleshoot integration issues | Sync log, structured logs, replay, runbook (§8.6, §14) |
| Support testing and deployment | Jest, CDK, GitHub Actions (§12) |
| Technical documentation, troubleshooting procedures, onboarding guides | README, RUNBOOK, ADDING_AN_INTEGRATION (§14) |
| Cloud-based integration technologies (asset) | AWS serverless stack (§5) |

---

## 2. Background you need

### 2.1 What an ERP is

An ERP (Enterprise Resource Planning system) is the company's financial system of record: customers, vendors, invoices, bills, payments, the general ledger. NetSuite is Oracle's cloud ERP. Finance trusts what is in it, so anything an integration writes must be correct, complete, and never duplicated.

### 2.2 Order-to-Cash (O2C)

How a company gets paid by its customers:

```
Sales order → Fulfillment → Invoice → Customer payment → Payment applied to invoice
```

In this project: the billing app issues an invoice and later receives a payment. Both must appear in the ERP, and the payment must be applied to the right invoice.

### 2.3 Procure-to-Pay (P2P)

How a company pays its suppliers:

```
Purchase request → Purchase order → Goods receipt → Vendor bill → Vendor payment
```

In this project: the procurement app approves a vendor bill. It must appear in the ERP so accounts payable can pay it.

### 2.4 NetSuite concepts the mock ERP imitates

| Concept | Meaning |
|---|---|
| Record | Any object in NetSuite: `customer`, `vendor`, `invoice`, `customerPayment`, `vendorBill` |
| Internal ID | NetSuite's own numeric ID for a record |
| External ID | An ID you assign from the source system. Used for upserts, and the key to avoiding duplicates |
| REST Record API | CRUD on records: `/services/rest/record/v1/{recordType}` |
| SuiteQL | SQL-like query language, sent as `POST /services/rest/query/v1/suiteql` |
| Integration record | The registered "app" that is allowed to call the API, with its credentials |
| Role | The permission set attached to the integration's credentials |

Verify details against Oracle's "SuiteTalk REST Web Services" documentation as you build. The mock is a learning aid, not a certified copy.

---

## 3. What is being built

Five pieces, in one monorepo:

| Piece | Tech | Purpose |
|---|---|---|
| `mock-erp` | NestJS on Lambda, DynamoDB | Stands in for NetSuite. Same URL shapes, same upsert-by-external-ID behaviour, a small SuiteQL subset |
| `integration-service` | NestJS on Lambda | The actual product: ingest, queue, transform, push, log, retry, reconcile |
| `dashboard` | Next.js (App Router) | Shows every sync and lets an operator replay failures |
| `infra` | AWS CDK (TypeScript) | All AWS resources as code |
| `simulator` | Node script | Pretends to be the billing and procurement apps. Sends good and bad events |

---

## 4. Architecture

```
 Billing app ─┐                                              ┌──────────────┐
 (simulator)  │  HTTPS webhook                               │   Mock ERP   │
              ├──► API Gateway ──► Ingest Lambda ──► SQS ──► Worker Lambda ─►│ (NetSuite-   │
 Procurement ─┘     (HTTP API)     verify, validate   │      map, upsert     │  shaped API) │
 app (simulator)                   log, enqueue       │           │          └──────▲───────┘
                                                      │           │                 │
 Finance user ──► S3 (CSV upload) ──► CSV Lambda ─────┘           ▼                 │ SuiteQL
                                                         DynamoDB sync log          │
                                        after N failures          ▲                 │
                                        SQS ──► DLQ               │        Reconcile Lambda
                                                 │                │        (EventBridge, nightly)
                                                 ▼                │
                                    CloudWatch alarm ──► SNS email│
                                                                  │
 Operator ──► Next.js dashboard ──► Admin API (API Gateway + Lambda)
```

### How one event travels

1. The billing app sends `invoice.created` to the webhook URL.
2. **Ingest Lambda** checks the HMAC signature, validates the body, writes a sync record with status `RECEIVED`, puts the event on SQS, and returns `202` immediately. The sender is never kept waiting on the ERP.
3. **Worker Lambda** takes the event from SQS, marks it `PROCESSING`, maps it to ERP records, and upserts them using external IDs.
4. On success the sync record becomes `SUCCEEDED` and stores the ERP record ID.
5. On a temporary failure, the message returns to the queue and is retried. After the maximum attempts it moves to the **dead-letter queue (DLQ)** and the record becomes `DEAD`.
6. A CloudWatch alarm watches the DLQ and emails the operator.
7. The operator opens the dashboard, reads the error, fixes the cause, and clicks **Replay**.

---

## 5. Tech stack and repository layout

- Node.js 20+, TypeScript (strict), pnpm workspaces
- NestJS 10+ for both backend services
- Next.js 14+ (App Router) for the dashboard
- AWS: API Gateway (HTTP API), Lambda, SQS, DynamoDB, S3, EventBridge, Secrets Manager, CloudWatch, SNS, IAM
- AWS CDK v2 for infrastructure
- zod for payload validation, Jest for tests
- Powertools for AWS Lambda (TypeScript) for structured logs and metrics

```
ledgerbridge/
├── apps/
│   ├── mock-erp/               NestJS
│   ├── integration-service/    NestJS
│   │   └── src/
│   │       ├── ingest/         webhook controllers, signature guard
│   │       ├── worker/         SQS handler, retry classification
│   │       ├── flows/
│   │       │   ├── o2c/        mappers + handlers for invoice, payment
│   │       │   └── p2p/        mappers + handlers for vendor bill, CSV
│   │       ├── erp-client/     OAuth token cache, record + SuiteQL calls
│   │       ├── sync-log/       DynamoDB repository
│   │       ├── reconcile/      nightly job
│   │       ├── admin/          API for the dashboard
│   │       └── lambda/         entry points: http.ts, worker.ts, csv.ts, reconcile.ts
│   └── dashboard/              Next.js
├── packages/
│   └── shared/                 event schemas (zod), shared types
├── infra/                      CDK app
├── scripts/
│   └── simulate.ts             fake source apps
├── docs/
│   ├── RUNBOOK.md
│   └── ADDING_AN_INTEGRATION.md
├── SPEC.md                     this file
└── README.md
```

### Known gotcha: NestJS on Lambda

- Nest's dependency injection relies on TypeScript decorator metadata. esbuild (the default bundler in CDK's `NodejsFunction`) does not emit it, which breaks injection at runtime. Build each service with `nest build --webpack` and deploy the output with `lambda.Function` + `Code.fromAsset`.
- HTTP Lambdas: wrap the Nest app with `@codegenie/serverless-express`, and cache the bootstrapped app between invocations.
- Non-HTTP Lambdas (worker, CSV, reconcile): use `NestFactory.createApplicationContext()`. No HTTP server is needed.
- Signature checks need the raw request body. Create the app with `rawBody: true`.

---

## 6. The integration flows

### 6.1 Order-to-Cash

**Event `invoice.created`** from the billing app:

```json
{
  "id": "evt_01HZX...",
  "type": "invoice.created",
  "occurredAt": "2026-11-11T09:30:00Z",
  "data": {
    "invoiceId": "INV-1042",
    "customer": { "id": "CUS-77", "name": "Cedar Logistics SAL", "email": "ap@cedar.example" },
    "issueDate": "2026-11-11",
    "dueDate": "2026-12-11",
    "currency": "USD",
    "lines": [
      { "sku": "PLAN-PRO", "description": "Pro plan, monthly", "quantity": 3, "unitPrice": 49.0 }
    ]
  }
}
```

Processing steps:

1. Upsert `customer` with external ID `CUS-77`.
2. Upsert `invoice` with external ID `INV-1042`, linked to that customer.

Mapping:

| Source field | ERP field (`invoice`) |
|---|---|
| `invoiceId` | `externalId`, `tranId` |
| `customer.id` | `entity` (reference by external ID) |
| `issueDate` | `tranDate` |
| `dueDate` | `dueDate` |
| `currency` | `currency` (via currency lookup table) |
| `lines[].sku` | `item.items[].item` (via item lookup table) |
| `lines[].quantity` | `item.items[].quantity` |
| `lines[].unitPrice` | `item.items[].rate` |

**Event `payment.received`**:

```json
{
  "id": "evt_01HZY...",
  "type": "payment.received",
  "occurredAt": "2026-11-20T14:02:00Z",
  "data": {
    "paymentId": "PAY-5531",
    "invoiceId": "INV-1042",
    "customerId": "CUS-77",
    "amount": 147.0,
    "currency": "USD",
    "method": "bank_transfer",
    "receivedDate": "2026-11-20"
  }
}
```

Processing steps:

1. Look up the invoice by external ID `INV-1042`.
2. If it does not exist yet, raise a **retryable** error (events can arrive out of order).
3. Upsert `customerPayment` with external ID `PAY-5531`, applied to that invoice.

Business rules:

- A payment amount greater than the invoice's remaining balance is a **permanent** error.
- Currency must match the invoice currency, otherwise **permanent** error.

### 6.2 Procure-to-Pay

**Event `bill.approved`** from the procurement app:

```json
{
  "id": "evt_01J0A...",
  "type": "bill.approved",
  "occurredAt": "2026-11-11T11:00:00Z",
  "data": {
    "billNumber": "BILL-2209",
    "vendor": { "id": "VEN-12", "name": "Beirut Office Supplies" },
    "billDate": "2026-11-10",
    "dueDate": "2026-12-10",
    "currency": "USD",
    "lines": [
      { "expenseCategory": "OFFICE_SUPPLIES", "description": "Printer paper", "amount": 240.0 }
    ]
  }
}
```

Processing steps:

1. Upsert `vendor` with external ID `VEN-12`.
2. Upsert `vendorBill` with external ID `BILL-2209`.

Mapping:

| Source field | ERP field (`vendorBill`) |
|---|---|
| `billNumber` | `externalId`, `tranId` |
| `vendor.id` | `entity` (reference by external ID) |
| `billDate` | `tranDate` |
| `dueDate` | `dueDate` |
| `lines[].expenseCategory` | `expense.items[].account` (via account lookup table) |
| `lines[].amount` | `expense.items[].amount` |
| `lines[].description` | `expense.items[].memo` |

An unknown `expenseCategory` is a **permanent** error. Finance must add the mapping first.

**CSV bulk import.** A finance user uploads a file to `s3://<bucket>/incoming/`. Columns:

```
bill_number,vendor_id,vendor_name,bill_date,due_date,currency,expense_category,description,amount
```

- Each row becomes one `bill.approved` event on the same queue. Rows sharing a `bill_number` become lines of one bill.
- Event ID is deterministic: `csv:<sha256 of file>:<bill_number>`, so re-uploading the same file changes nothing.
- Invalid rows are written to `s3://<bucket>/rejected/<file>.errors.csv` with a reason column. Valid rows still proceed.
- The processed file moves to `processed/`.

### 6.3 Lookup tables

Keep these as a typed config module in the integration service (seeded in code is fine):

- `sku → ERP item ID`
- `expenseCategory → ERP account ID`
- `currency code → ERP currency ID`

---

## 7. Mock ERP requirements

### 7.1 Authentication

- `POST /services/rest/auth/oauth2/v1/token` with `grant_type=client_credentials`, `client_id`, `client_secret`.
- Returns `{ "access_token": "...", "token_type": "Bearer", "expires_in": 3600 }`. Tokens are signed JWTs.
- Every other endpoint requires `Authorization: Bearer <token>` and returns `401` otherwise.
- Note for interviews: real NetSuite's client-credentials flow uses a signed JWT assertion with a certificate rather than a plain secret. The mock simplifies this on purpose.

### 7.2 Record API

Base path `/services/rest/record/v1`. Record types: `customer`, `vendor`, `invoice`, `customerPayment`, `vendorBill`.

| Method and path | Behaviour |
|---|---|
| `POST /{type}` | Create. `204` with a `Location` header pointing at the new record |
| `GET /{type}/{id}` | Read by internal ID. `404` if missing |
| `GET /{type}/eid:{externalId}` | Read by external ID |
| `PATCH /{type}/{id}` | Partial update |
| `PUT /{type}/eid:{externalId}` | **Upsert** by external ID. Creates if missing, updates if present |
| `DELETE /{type}/{id}` | Delete |

Rules:

- Internal IDs are sequential integers assigned by the mock.
- `externalId` is unique per record type. A `POST` with an existing `externalId` returns `400`.
- Reference fields accept `{ "id": "123" }` or `{ "externalId": "CUS-77" }`. A reference to a missing record returns `400` with a clear message.
- `invoice` tracks `total`, `amountPaid`, `amountRemaining`, and `status` (`open`, `paidInFull`). Creating a `customerPayment` updates the invoice it applies to.
- Error bodies follow NetSuite's style:
  ```json
  { "type": "...", "title": "Bad Request", "status": 400,
    "o:errorDetails": [ { "detail": "Invalid reference: customer CUS-99", "o:errorCode": "INVALID_REFERENCE" } ] }
  ```

### 7.3 SuiteQL endpoint

- `POST /services/rest/query/v1/suiteql`, header `Prefer: transient`, body `{ "q": "SELECT ..." }`.
- Query params `limit` and `offset`.
- Response: `{ "items": [...], "count": n, "offset": n, "totalResults": n, "hasMore": false }`.
- Supported grammar (deliberately small; reject anything else with `400`):
  ```
  SELECT <columns | *> FROM <customer|vendor|invoice|customerPayment|vendorBill>
  [WHERE <field> <=|!=|>|>=|<|<=> <literal> [AND ...]]
  [ORDER BY <field> [ASC|DESC]]
  ```

### 7.4 Failure injection

For testing resilience, controlled by environment variables or an admin endpoint:

- `CHAOS_ERROR_RATE` — fraction of requests answered with `503`.
- `CHAOS_LATENCY_MS` — added delay.
- Rate limit: more than N requests per second returns `429` with `Retry-After`.

### 7.5 Storage

One DynamoDB table, `pk = <recordType>`, `sk = <internalId>`, with a GSI on `externalId`. A counter item per record type generates internal IDs.

---

## 8. Integration service requirements

### 8.1 Ingest (webhooks)

Endpoints:

- `POST /webhooks/billing`
- `POST /webhooks/procurement`

Requirements:

1. Verify `X-Signature` = hex HMAC-SHA256 of `"<X-Timestamp>.<raw body>"` using that source's secret. Compare in constant time. Reject with `401` on mismatch.
2. Reject if `X-Timestamp` is more than 5 minutes old (replay protection).
3. Validate the body against the zod schema for its `type`. Invalid payload: `400`, and write a sync record with status `REJECTED` so it is visible on the dashboard.
4. Deduplicate on event `id` using a DynamoDB conditional write. A repeated ID returns `200` and does nothing.
5. Write the sync record (`RECEIVED`), send to SQS, return `202 { "syncId": "..." }`.
6. Target response time under 500 ms. No ERP calls in this Lambda.

### 8.2 Worker

- Triggered by SQS, batch size 5, with `ReportBatchItemFailures` so one bad message does not fail its whole batch.
- Routes on event `type` to a flow handler. Adding a flow means adding a handler and a schema, with no changes to the worker itself.
- Error classification:

| Class | Examples | Action |
|---|---|---|
| Retryable | ERP `5xx`, `429`, timeout, network error, dependency not yet present | Status `RETRYING`, return the message to the queue |
| Permanent | ERP `400`, unknown mapping, business rule violation | Status `FAILED`, delete the message, no retry |

- SQS redrive policy: `maxReceiveCount = 4`, then the message goes to the DLQ.
- A small Lambda on the DLQ sets the sync record to `DEAD`.
- Honour `Retry-After` on `429` by setting the message's visibility timeout.

### 8.3 Idempotency

Two layers, both required:

1. **Event level:** the event `id` is the sync record key. Processing an event already `SUCCEEDED` is a no-op.
2. **Record level:** every ERP write is `PUT /{type}/eid:{externalId}`. Running the same event twice produces the same single record.

### 8.4 ERP client

- A Nest module wrapping all ERP HTTP calls: `upsert(type, externalId, body)`, `getByExternalId(type, externalId)`, `suiteql(query)`.
- Fetches an OAuth token, caches it in memory until shortly before expiry, and refreshes once on a `401`.
- Reads client credentials from Secrets Manager, cached in memory.
- 10-second request timeout. Converts ERP error bodies into typed errors carrying the retryable/permanent class.
- Base URL comes from configuration, so pointing at a real NetSuite account later is a config change plus auth changes.

### 8.5 Sync log (DynamoDB)

Table `SyncLog`, `pk = eventId`.

| Attribute | Notes |
|---|---|
| `eventId` | Partition key |
| `source` | `billing`, `procurement`, `csv` |
| `flow` | `O2C` or `P2P` |
| `eventType` | e.g. `invoice.created` |
| `status` | `RECEIVED`, `PROCESSING`, `SUCCEEDED`, `RETRYING`, `FAILED`, `DEAD`, `REJECTED` |
| `attempts` | Incremented per try |
| `businessKey` | e.g. `INV-1042`, for searching |
| `erpRecordType`, `erpRecordId` | Set on success |
| `lastError` | `{ code, message, class }` |
| `payload` | Original event, kept for replay |
| `receivedAt`, `updatedAt`, `completedAt` | ISO timestamps |
| `ttl` | Expire after 90 days |

GSI `byStatus`: `pk = status`, `sk = updatedAt`. Used by the dashboard.

### 8.6 Admin API (for the dashboard)

Protected by an API key header. Never called from the browser directly.

| Endpoint | Purpose |
|---|---|
| `GET /admin/syncs?status=&flow=&q=&cursor=` | Paginated list, newest first |
| `GET /admin/syncs/{eventId}` | Full detail including payload and error |
| `POST /admin/syncs/{eventId}/replay` | Allowed for `FAILED` and `DEAD`. Resets attempts and re-enqueues |
| `GET /admin/stats` | Counts per status and flow for the last 24 hours, DLQ depth |

### 8.7 Reconciliation

- EventBridge schedule, daily at 02:00 UTC.
- For the last 24 hours: take all `SUCCEEDED` sync records, then SuiteQL-query the ERP for invoices, payments, and vendor bills created in the same window.
- Report records present on one side and missing on the other.
- Emit a `ReconciliationMismatches` metric and store a summary item that the dashboard can show.

---

## 9. Dashboard requirements (Next.js)

- **Overview page:** tiles for succeeded, retrying, failed, dead in the last 24 hours, DLQ depth, last reconciliation result.
- **Syncs page:** table with status, flow, event type, business key, attempts, updated time. Filter by status and flow. Search by business key. Cursor pagination.
- **Sync detail page:** timeline of status changes, formatted payload, error detail, ERP record ID, a **Replay** button for `FAILED` and `DEAD`.
- All data fetched server-side (server components or route handlers) so the admin API key stays on the server.
- Auto-refresh the overview every 15 seconds.
- Runs locally against the deployed API. Deploying it (Vercel or Amplify) is optional.

---

## 10. Security requirements

- No secrets in code or in plain Lambda environment variables. Webhook secrets, ERP client credentials, and the admin API key live in Secrets Manager.
- One IAM role per Lambda with only the actions and resources it needs. Example: the ingest Lambda may `sqs:SendMessage` to the one queue and write to the sync table, and nothing else.
- HMAC signature plus timestamp check on every webhook.
- S3 bucket: block public access, encryption at rest, uploads restricted to the `incoming/` prefix.
- Logs must not contain secrets, tokens, or full customer emails.
- API Gateway throttling enabled on all routes.

---

## 11. Observability requirements

- **Structured JSON logs** on every Lambda with `eventId`, `flow`, `eventType`, `attempt` on every line, so one event can be traced end to end in CloudWatch Logs Insights.
- **Custom metrics** (namespace `LedgerBridge`): `SyncSucceeded`, `SyncFailed`, `SyncRetried`, `SyncDurationMs`, `ReconciliationMismatches`, each with a `flow` dimension.
- **Alarms** (all notify one SNS topic with an email subscription):
  - DLQ visible messages > 0
  - `SyncFailed` ≥ 5 in 5 minutes
  - Worker Lambda errors > 0 for 2 consecutive periods
  - Age of oldest queue message > 10 minutes
  - `ReconciliationMismatches` > 0
- **CloudWatch dashboard** defined in CDK: queue depth, success vs failure rate, duration p50/p95, DLQ depth.

---

## 12. Testing and deployment

### Tests

- **Unit:** every mapper (source event → ERP body), error classification, signature verification, CSV row parsing. Include edge cases: missing optional fields, unknown mapping, zero-line invoice.
- **Integration (local):** run mock ERP and integration service together. Assert that sending the same event twice yields one ERP record, and that a payment before its invoice eventually succeeds.
- **Contract:** the ERP client's requests match the mock ERP's routes.
- Target 80% coverage on `flows/` and `erp-client/`.

### Simulator (`scripts/simulate.ts`)

Commands:

- `happy` — 10 invoices, their payments, 5 vendor bills.
- `out-of-order` — payment sent before its invoice.
- `duplicates` — same event sent three times.
- `bad-signature`, `bad-payload`, `unknown-category` — expected rejections and permanent failures.
- `load --count 200` — burst to observe queueing and rate limiting.
- `csv` — uploads a sample file with some invalid rows.

### Deployment

- `pnpm build` then `cdk deploy` creates everything. `cdk destroy` removes everything.
- Two CDK stacks: `MockErpStack` and `LedgerBridgeStack`, so the integration could later point at a real ERP without the mock.
- GitHub Actions: lint, type-check, test on every push. Deploy job is manual.
- **Cost guardrails:** create an AWS Budget alert at a few dollars before the first deploy. No RDS, no NAT gateway, no provisioned concurrency. DynamoDB on-demand. Log retention 7 days.

---

## 13. Build order and acceptance criteria

Build one milestone at a time. Do not start the next until the current one meets its "done when".

| # | Milestone | Done when |
|---|---|---|
| 1 | Monorepo, shared schemas, mock ERP running locally (in-memory store first) | You can get a token, upsert a customer by external ID twice and see one record, and run a SuiteQL `SELECT` |
| 2 | Integration service locally: ingest, mappers, ERP client, worker called directly (no queue yet) | `simulate happy` creates the right records in the mock ERP. Mapper unit tests pass |
| 3 | AWS base: CDK stacks, mock ERP on Lambda + DynamoDB, API Gateway, ingest Lambda, SQS + DLQ | A signed webhook sent to the real URL returns `202` and the message appears in SQS |
| 4 | Worker Lambda, sync log, Secrets Manager, idempotency, error classification | `simulate duplicates` and `out-of-order` both end with correct, single records and `SUCCEEDED` status |
| 5 | P2P CSV import via S3, DLQ handler | `simulate csv` creates the valid bills and writes a rejected-rows file |
| 6 | Logs, metrics, alarms, SNS email, CloudWatch dashboard | With `CHAOS_ERROR_RATE=1`, messages reach the DLQ and you receive the alarm email |
| 7 | Admin API and Next.js dashboard with replay | You find the dead events on the dashboard, turn chaos off, click Replay, and they succeed |
| 8 | Reconciliation job, docs, CI | Deleting an invoice directly in the mock ERP causes the next reconciliation run to flag it. README, RUNBOOK, and ADDING_AN_INTEGRATION are written |

Minimum strong demo if time is short: milestones 1–4 plus the DLQ alarm from 6.

---

## 14. Documentation deliverables

- **README.md:** what it is, architecture diagram, how to deploy, how to run the simulator, screenshots of the dashboard, and a section "How this maps to real NetSuite".
- **docs/RUNBOOK.md:** for each alarm, what it means, how to investigate (the Logs Insights query to run), and how to resolve and replay.
- **docs/ADDING_AN_INTEGRATION.md:** the steps to onboard a new source app: schema, mapper, handler, secret, tests.

---

## 15. Out of scope

- A real NetSuite connection, SuiteScript, or RESTlets.
- Multi-currency conversion, tax calculation, partial fulfillment.
- User accounts and login on the dashboard.
- Syncing from the ERP back to the source apps.

---

## 16. What you should be able to explain afterwards

1. Why the webhook returns `202` and the work happens behind a queue.
2. How external IDs and upserts make retries safe, and why that matters for finance data.
3. The difference between a retryable and a permanent failure, with an example of each from O2C and P2P.
4. What happens when a payment arrives before its invoice.
5. What a dead-letter queue is, and how an operator finds, fixes, and replays a failed sync.
6. How credentials are stored and why each Lambda has its own IAM role.
7. Why reconciliation is needed even when every sync reports success.
8. What would change to point this at real NetSuite: base URL, the certificate-based OAuth flow, real record field names and internal IDs, and NetSuite's concurrency limits.

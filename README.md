# LedgerBridge

**An integration hub that moves invoices, payments and vendor bills from business apps into an ERP, automatically and without duplicates.**

Built with NestJS and Next.js on AWS serverless. The ERP is a mock that copies NetSuite's REST API, so the integration code is written the way it would be against the real thing.

![How LedgerBridge works: business apps send events through a front door and a queue to a worker, which writes them to the ERP exactly once. Failures are retried, then parked in a dead-letter queue, an alert email is sent, and an operator replays them from a dashboard.](docs/how-it-works.svg)

---

## The short version

Companies run their finances in an ERP such as NetSuite. Their invoices, payments and supplier bills are created somewhere else: a billing app, a procurement app, a spreadsheet. Someone has to get that data into the ERP, and finance has to be able to trust it.

LedgerBridge does that job. It covers the two core finance flows:

| Flow | What it means | What LedgerBridge syncs |
|---|---|---|
| **Order-to-Cash** | How a company gets paid by its customers | Customers, invoices, and payments applied to the right invoice |
| **Procure-to-Pay** | How a company pays its suppliers | Vendors and vendor bills, from a webhook or a CSV upload |

Sending the data is the easy part. The project is about what happens when things go wrong:

- **The same event arrives twice.** Only one record is created.
- **The ERP is down or rate-limiting.** The event waits and is retried by itself.
- **A payment arrives before its invoice.** It is retried until the invoice exists.
- **The data is wrong.** It is not retried forever. It is marked as failed with a clear reason.
- **Something still fails after four tries.** It is parked, an alert email goes out, and an operator can fix the cause and replay it from a dashboard.

## What this project demonstrates

| Skill | Where to see it |
|---|---|
| ERP integration through REST APIs (create, read, update, upsert) | [`erp-client/`](apps/integration-service/src/erp-client/), [`flows/`](apps/integration-service/src/flows/) |
| NetSuite concepts: records, external IDs, SuiteQL, OAuth 2.0 | [`apps/mock-erp/`](apps/mock-erp/) |
| Data mapping between two systems | Mappers in [`flows/o2c/`](apps/integration-service/src/flows/o2c/) and [`flows/p2p/`](apps/integration-service/src/flows/p2p/) |
| Reliability: idempotency, retries, dead-letter queue, replay | [`worker/`](apps/integration-service/src/worker/), [`intake/`](apps/integration-service/src/intake/), [`dlq/`](apps/integration-service/src/dlq/) |
| Security: signed webhooks, secrets management, least-privilege IAM | [`ingest/`](apps/integration-service/src/ingest/), [`secrets/`](apps/integration-service/src/secrets/), [`infra/`](infra/) |
| Monitoring: structured logs, metrics, alarms, email alerts | [`observability/`](apps/integration-service/src/observability/), [`infra/lib/monitoring.ts`](infra/lib/monitoring.ts) |
| Operator dashboard | [`apps/dashboard/`](apps/dashboard/) |
| Infrastructure as code on AWS | [`infra/`](infra/) (AWS CDK) |
| Automated testing | 258 unit tests, plus end-to-end tests that run the service against the mock ERP |

---

## How one event travels

The numbers match the diagram.

1. **A business app sends an event**, for example `invoice.created`, to a webhook URL. Finance can also upload a CSV of vendor bills to S3; each bill becomes the same kind of event.
2. **The front door** (API Gateway + ingest Lambda) checks the HMAC signature and timestamp, validates the payload, records the event as `RECEIVED`, and puts it on the queue. It answers `202` straight away, so the sender never waits on the ERP.
3. **The queue** (SQS) holds the event until a worker is free. A burst of events queues up instead of flooding the ERP.
4. **The worker** (Lambda) maps the event to ERP records and writes them with an upsert by external ID: "create if missing, update if present". Running the same event twice still gives one record.
5. **The ERP** holds the result, and the sync record becomes `SUCCEEDED` with the ERP record ID.

When something fails:

- A **temporary failure** (ERP returns 5xx or 429, a timeout, an invoice that hasn't arrived yet) sends the event back to the queue. It is retried after 10 s, 30 s and 90 s, or after the ERP's own `Retry-After`.
- A **permanent failure** (bad data, an unknown expense category, a payment larger than the invoice balance) is marked `FAILED` at once. Retrying would not help.

6. After four failed tries the event moves to the **dead-letter queue** and is marked `DEAD`. The original payload is kept.
7. A **CloudWatch alarm** emails the operator.
8. On the **dashboard**, the operator reads the error, fixes the cause, and clicks **Replay**. The event goes back on the queue.

Every status change is written to a sync log in DynamoDB, so each event has a full timeline.

## What's in the repo

```
ledgerbridge/
├── apps/
│   ├── integration-service/   The product: webhooks, queue worker, CSV import, admin API (NestJS)
│   ├── mock-erp/              Stand-in for NetSuite: records, OAuth, SuiteQL, failure injection (NestJS)
│   └── dashboard/             Operator dashboard: overview, sync list, timeline, replay (Next.js)
├── packages/shared/           Event schemas and shared types (zod)
├── infra/                     Every AWS resource as code (AWS CDK)
├── scripts/                   Simulator that plays the billing and procurement apps, plus helpers
└── docs/                      Build plan and the diagram above
```

**Stack:** TypeScript, NestJS 12, Next.js 16, zod, Vitest, AWS CDK.
**AWS services:** API Gateway, Lambda, SQS, DynamoDB, S3, Secrets Manager, CloudWatch, SNS, IAM.

## Run it locally

No AWS needed. Locally the queue is skipped and records are kept in memory.

Requires Node.js 22.18 or newer.

```bash
npm install
cp .env.example .env
npm run build
```

Then, in two terminals:

```bash
npm run start:dev -w mock-erp              # the fake ERP, http://localhost:3001
npm run start:dev -w integration-service   # LedgerBridge, http://localhost:3000
```

And in a third:

```bash
npm run simulate -- happy
```

This sends 10 invoices, their payments and 5 vendor bills, then reads the ERP and checks that every record is there and every invoice is paid in full.

To see the dashboard against the local service:

```bash
npm run dashboard:env -- --local
npm run dashboard                          # http://localhost:3002
```

## Try the failure scenarios

The simulator plays the source apps, including the badly behaved ones. Add `--aws` to run against the deployed stack.

| Command | What it shows |
|---|---|
| `npm run simulate -- happy` | The normal path for both flows |
| `npm run simulate -- duplicates` | The same event sent three times creates one record |
| `npm run simulate -- out-of-order --aws` | A payment sent before its invoice is retried until it succeeds |
| `npm run simulate -- bad-signature` | A wrong secret or old timestamp is refused with `401` |
| `npm run simulate -- bad-payload` | Invalid data is refused with `400` and shown as `REJECTED` |
| `npm run simulate -- unknown-category` | A bill with an unmapped category ends `FAILED` and is not retried |
| `npm run simulate -- csv --aws` | A CSV with some bad rows: good bills sync, bad rows land in an errors file, re-uploading changes nothing |
| `npm run simulate -- dead --aws` | An event fails four times and ends `DEAD` |
| `npm run simulate -- outage --aws` | With the ERP forced down (`npm run chaos -- 1`), events go dead and the alarm email arrives |

## Deploy to AWS

You need the AWS CLI with a profile named `ledgerbridge`. The Region is set in [`infra/bin/app.ts`](infra/bin/app.ts).

```bash
npm run aws:secrets                             # once: creates the secrets in Secrets Manager
npm run cdk -- bootstrap --profile ledgerbridge # once per AWS account and Region
npm run deploy                                  # builds and deploys both stacks
npm run dashboard:env && npm run dashboard      # dashboard against the deployed API
```

`npm run destroy` removes everything. Idle cost is about $1.20 a month (three secrets); the rest is billed per request.

More detail: [infra/README.md](infra/README.md).

## Tests

```bash
npm test            # unit tests in every package
npm run test:e2e    # the integration service against the mock ERP, over HTTP
npm run typecheck
npm run lint
```

The end-to-end tests cover the stories above without AWS: duplicates, out-of-order events, an ERP outage that ends in the dead-letter queue, and replay through the admin API.

## How this maps to real NetSuite

The mock ERP copies the parts of NetSuite's SuiteTalk REST API that the integration depends on:

| NetSuite concept | In the mock |
|---|---|
| REST Record API | `/services/rest/record/v1/{type}` for `customer`, `vendor`, `invoice`, `customerPayment`, `vendorBill` |
| Upsert by external ID | `PUT /{type}/eid:{externalId}` |
| SuiteQL | `POST /services/rest/query/v1/suiteql`, a small `SELECT ... WHERE ... ORDER BY` subset |
| OAuth 2.0 client credentials | Token endpoint returning a signed JWT |
| Error format | NetSuite-style bodies with `o:errorDetails` |
| Rate limits | `429` with `Retry-After` |

Pointing LedgerBridge at a real NetSuite account would mean changing:

- the base URL (already a config value),
- authentication, because real NetSuite uses a signed JWT assertion with a certificate instead of a client secret,
- the lookup tables, to use the account's real item, account and currency IDs,
- concurrency settings, to respect the account's request limits.

The mock is a learning aid, not a certified copy of NetSuite.

## Status

Working today: both flows, CSV import, retries and dead-letter handling, monitoring and alarms, the admin API, and the dashboard with replay.

Not built yet:

- Nightly reconciliation that compares the sync log with the ERP
- CI with GitHub Actions
- A runbook and a guide for adding a new integration

## Further reading

- [SPEC.md](SPEC.md): the full requirements
- [docs/PLAN.md](docs/PLAN.md): the build plan, with the reasoning behind each design decision
- [apps/integration-service/README.md](apps/integration-service/README.md): code map and how to add an event type
- [apps/mock-erp/README.md](apps/mock-erp/README.md): the mock ERP's endpoints
- [apps/dashboard/README.md](apps/dashboard/README.md): dashboard pages and how the admin key stays on the server

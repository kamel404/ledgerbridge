# LedgerBridge — Build Plan

This file turns [SPEC.md](../SPEC.md) into phases you can work through one at a time. Each phase has:

- **Goal**: what it adds, in one sentence.
- **Concepts**: what you need to understand first. AWS services are explained from scratch.
- **Tasks**: checkboxes. Tick them as you go.
- **Done when**: the test that says the phase is finished. Don't start the next phase until it passes.
- **How to check**: the commands or clicks that prove it.

If you have never used AWS, read [Part A](#part-a--aws-for-beginners) first. Phases 0–2 run entirely on your own machine and need no AWS account, so you can start coding while you read.

---

## Contents

- [Part A — AWS for beginners](#part-a--aws-for-beginners)
- [Part B — Decisions taken from the scaffold](#part-b--decisions-taken-from-the-scaffold)
- [Phase 0 — Foundations](#phase-0--foundations)
- [Phase 1 — Shared schemas and mock ERP (local)](#phase-1--shared-schemas-and-mock-erp-local)
- [Phase 2 — Integration service (local, no queue)](#phase-2--integration-service-local-no-queue)
- [Phase 3 — First deploy to AWS](#phase-3--first-deploy-to-aws)
- [Phase 4 — Worker, retries and idempotency](#phase-4--worker-retries-and-idempotency)
- [Phase 5 — CSV import and dead-letter handling](#phase-5--csv-import-and-dead-letter-handling)
- [Phase 6 — Logs, metrics and alarms](#phase-6--logs-metrics-and-alarms)
- [Phase 7 — Admin API and dashboard](#phase-7--admin-api-and-dashboard)
- [Phase 8 — Reconciliation, docs and CI](#phase-8--reconciliation-docs-and-ci)
- [Gaps in the spec and how we handle them](#gaps-in-the-spec-and-how-we-handle-them)
- [Glossary](#glossary)

---

## Part A — AWS for beginners

### A.1 What AWS is, in one paragraph

AWS (Amazon Web Services) rents you computers, storage and ready-made building blocks over the internet, and charges for what you use. You don't run a server. Each piece of LedgerBridge is one AWS **service**: one for running code, one for queues, one for the database, and so on. You describe all of them in TypeScript code (**CDK**), and one command creates them.

### A.2 "Serverless", and why this project uses it

"Serverless" means you hand AWS a function and it runs it when something happens: an HTTP request, a message on a queue, a file upload, a timer. You pay per run, nothing while idle. For a small demo like this one, that means a monthly bill of cents to a few dollars, and nothing to patch or keep running.

### A.3 The services you will use

Read this table once now. Each phase repeats the explanation for the services it introduces.

| Service | What it is | Everyday comparison | Where LedgerBridge uses it |
|---|---|---|---|
| **Lambda** | Runs one function of your code each time an event happens. Max 15 min per run. | A cook who only comes in when an order arrives | Every backend piece: ingest, worker, CSV, DLQ handler, reconcile, admin API, mock ERP |
| **API Gateway (HTTP API)** | Gives your Lambda a public HTTPS URL. Handles routing and throttling. | The restaurant's front door and host | Webhook URLs, the admin API, the mock ERP's URL |
| **SQS** (Simple Queue Service) | A queue of messages. One side puts messages in, the other takes them out when ready. | A ticket rail in a kitchen | Between ingest and the worker, so webhooks return fast and failures can retry |
| **DLQ** (dead-letter queue) | A second SQS queue that receives messages that failed too many times | A "problem orders" tray | Holds events that failed 4 times |
| **DynamoDB** | A NoSQL key-value database. No server, pay per read/write. | A huge, fast filing cabinet indexed by a label | The sync log, and the mock ERP's records |
| **S3** (Simple Storage Service) | Stores files ("objects") in "buckets". Can trigger a Lambda when a file arrives. | A shared drive | CSV uploads: `incoming/`, `processed/`, `rejected/` |
| **EventBridge** | Event routing and schedules (cron) | An alarm clock | Runs reconciliation every night at 02:00 UTC |
| **Secrets Manager** | Encrypted storage for passwords and keys, read by code at runtime | A safe | Webhook secrets, ERP credentials, admin API key |
| **IAM** (Identity and Access Management) | Who is allowed to do what, on which resource | Key cards that open only certain doors | One role per Lambda with only the permissions it needs |
| **CloudWatch** | Logs, metrics, alarms and dashboards | The building's CCTV and smoke detectors | Structured logs, custom metrics, 5 alarms, a dashboard |
| **SNS** (Simple Notification Service) | Sends a message to subscribers (email, SMS, other services) | A PA system | Alarm emails to you |
| **CDK** (Cloud Development Kit) | Describes all the above in TypeScript; turns it into a CloudFormation template | Architect's blueprints | The `infra/` folder |
| **CloudFormation** | The AWS engine that creates, updates and deletes resources from a template. CDK uses it underneath. | The construction crew | You'll only see it in the console as "stacks" |

### A.4 Words that come up all the time

- **Region**: a geographic data centre group, e.g. `eu-central-1` (Frankfurt), `us-east-1` (Virginia). Everything in this project lives in one region. Pick one and stick to it; if you can't find something in the console, check the region selector (top right) first.
- **ARN** (Amazon Resource Name): the unique "address" of any resource, e.g. `arn:aws:sqs:eu-central-1:123456789012:ledgerbridge-queue`. IAM policies list ARNs to say "this role may touch *this* queue".
- **Stack**: a group of resources created and deleted together. We have two: `MockErpStack` and `LedgerBridgeStack`.
- **Console**: the AWS website at console.aws.amazon.com. Good for looking; CDK is for changing.
- **Free tier**: AWS gives new accounts free usage or credits. The rules changed over time, so check the current offer for your account rather than assuming.

### A.5 One-time account setup (do this before Phase 3)

1. **Create an AWS account** at aws.amazon.com. It needs a card.
2. **Turn on MFA for the root user** (the email you signed up with). After this, don't use the root user for daily work.
3. **Create a budget alert**: Billing → Budgets → Create budget → "Zero spend" or a monthly budget of e.g. $5 with an email alert. The spec requires this before the first deploy.
4. **Create a daily-use login** with IAM Identity Center (the AWS-recommended way): enable it, create a user, give it the `AdministratorAccess` permission set for your account. Admin is fine for a personal learning account; the *Lambdas* will still get narrow permissions.
5. **Install the AWS CLI v2** and log in:
   ```bash
   aws configure sso          # follow the prompts, name the profile e.g. "ledgerbridge"
   aws sso login --profile ledgerbridge
   aws sts get-caller-identity --profile ledgerbridge   # prints your account ID = it works
   ```
6. **Install CDK and bootstrap** (once per account + region). Bootstrapping creates a small S3 bucket and roles that CDK needs to upload your code:
   ```bash
   npm install -g aws-cdk
   cdk bootstrap --profile ledgerbridge
   ```

### A.6 What will this cost?

For this workload almost everything sits in "pennies" territory: Lambda, SQS, DynamoDB on-demand, S3, API Gateway and SNS all charge per request, and you'll make thousands of requests, not millions.

Things that **do** cost a little even when idle:

| Item | Rough cost | How we keep it low |
|---|---|---|
| Secrets Manager | about $0.40 per secret per month | Keep the count small (see Phase 4) |
| CloudWatch alarms | about $0.10 per alarm per month beyond the free allowance | We only make 5–6 |
| CloudWatch logs | per GB stored | 7-day retention on every log group |

Things the spec bans because they are expensive: RDS databases, NAT gateways, provisioned concurrency. When you finish, `cdk destroy` removes everything and the bill goes back to zero.

---

## Part B — Decisions taken from the scaffold

The scaffold was generated with newer defaults than the spec assumes. We keep the scaffold's choices and treat the spec as updated:

| Spec says | We use | Why it's fine |
|---|---|---|
| pnpm workspaces | **npm workspaces** | Already set up; same idea (several packages in one repo) |
| Jest | **Vitest** | Same `describe/it/expect` style, faster, already configured |
| NestJS 10+ | **NestJS 12, ESM** (`"type": "module"`) | Newer. ESM + Lambda bundling is the one risk, so Phase 0 tests it first |
| ESLint | **oxlint** | Already configured |
| `nest build --webpack` (§5 gotcha) | **`nest build --builder rspack`** | Found in Phase 0: Nest 12's webpack builder refuses ESM projects. rspack is webpack-compatible, and the Nest CLI configures its SWC loader with `decoratorMetadata: true`, so dependency injection still works. Same outcome the spec wanted: one bundled file per Lambda, deployed with `lambda.Function` + `Code.fromAsset` |

---

## Phase 0 — Foundations

**Goal:** a clean monorepo where every package builds, tests and lints from the root, and proof that a Nest app can run the way Lambda will run it.

**Needs AWS?** No.

### Concepts

- **Monorepo / workspaces**: several packages (`apps/mock-erp`, `apps/integration-service`, `packages/shared`, …) in one Git repo. npm links them, so `import { InvoiceCreated } from '@ledgerbridge/shared'` works without publishing anything.
- **Strict TypeScript**: catches `undefined` mistakes at compile time. A shared `tsconfig.base.json` keeps all packages on the same rules.
- **Why the spike:** Lambda doesn't run `npm start`. It loads one JavaScript file and calls an exported `handler` function. Nest needs decorator metadata (the information `@Injectable()` relies on), which some bundlers drop. If that breaks, injection fails *at runtime in AWS*, which is the most painful place to find out. So we prove it locally now.
- **serverless-express**: a small adapter that turns a Lambda HTTP event into a normal Express request, so the Nest app doesn't know it's on Lambda.

### Tasks

- [x] Root `tsconfig.base.json` with `strict: true`; each package's `tsconfig.json` extends it
- [x] Root scripts: `build`, `test`, `lint`, `typecheck` that run in every workspace (`npm run <x> --workspaces --if-present`)
- [x] Make `packages/shared` a real TypeScript package: `src/index.ts`, build to `dist/`, `exports` field, and check that both apps can import from it
- [x] Delete the generated "hello world" controller/service/spec in both apps (replaced by a `/health` endpoint)
- [x] `.env.example` at the root listing local ports and **local-only** dev secrets
- [x] **Spike:** bundle both apps for Lambda (rspack, see Part B), wrap the app with `@codegenie/serverless-express` in `src/lambda/http.ts`, and call the handler from `scripts/invoke-lambda.mjs` with a fake API Gateway event. Route answers, injection works.
- [x] Write down the spike's outcome in the app READMEs

### What came out of the spike

- **Builder:** `nest build --webpack` fails on ESM projects; `nest build --builder rspack --rspackPath rspack.config.cjs` works and keeps decorator metadata.
- **`rspack.config.cjs`** (one per app) overrides the Nest defaults to: bundle all `node_modules` into the file (Lambda has no `node_modules` folder), output CommonJS, force one file per entry, and skip Nest's optional packages (microservices, websockets, class-validator) when they aren't installed.
- **Output:** `dist-lambda/http.js` (~3 MB) plus a `package.json` saying `"type": "commonjs"`. In Phase 3, CDK uploads that folder and the handler is `http.handler`.
- **Local cold start:** about 40 ms; warm calls reuse the cached app.
- **Windows tip:** in Git Bash, prefix commands that take a URL path with `MSYS_NO_PATHCONV=1`, otherwise `/health` is rewritten to `C:/Program Files/Git/health`.

### Done when

`npm run build`, `npm test`, `npm run lint` and `npm run typecheck` all pass from the root, and the spike script gets a real response from the bundled handler.

---

## Phase 1 — Shared schemas and mock ERP (local)

**Goal:** a fake NetSuite running on your laptop that behaves like the real one where it matters: OAuth tokens, upsert by external ID, references, invoice balances, SuiteQL.

**Needs AWS?** No. Data lives in memory (lost on restart, which is fine for now).

### Concepts

- **Why a mock ERP:** we have no NetSuite account. The mock copies NetSuite's URL shapes and behaviour so the integration code is written as if it were talking to the real thing (SPEC §2.4, §7).
- **Internal ID vs external ID:** the ERP numbers its records itself (`internalId` = 1, 2, 3 …). The *external ID* is *our* ID from the source app (`INV-1042`). Writing with `PUT /invoice/eid:INV-1042` means "create it if missing, update it if present". Doing that twice still gives one record. This is the whole anti-duplicate trick.
- **OAuth 2.0 client credentials:** the integration proves who it is by sending a client ID + secret and gets back a short-lived **access token** (a signed **JWT**). Every later call sends `Authorization: Bearer <token>`. Real NetSuite uses a certificate instead of a secret; the mock simplifies this on purpose.
- **SuiteQL:** NetSuite's SQL-like query language. We support a tiny subset (`SELECT … FROM … WHERE … ORDER BY`) and reject everything else. Reconciliation (Phase 8) uses it.
- **Zod schemas:** describe what a valid event looks like and check incoming JSON against it. The same schema also gives you the TypeScript type, so validation and types never drift apart.
- **Repository interface:** the mock talks to a `RecordStore` interface. Now it's an in-memory map; in Phase 3 we swap in DynamoDB without touching the business logic.

### Tasks

**Shared package**
- [x] Event envelope schema (`id`, `type`, `occurredAt`, `data`)
- [x] Schemas for `invoice.created`, `payment.received`, `bill.approved` (copy the shapes from SPEC §6)
- [x] Shared types: `SyncStatus`, `Flow` (`O2C`/`P2P`), `Source`, `ErrorClass` (`retryable`/`permanent`)
- [x] Schema tests: valid samples pass, broken ones fail with a useful message

**Mock ERP**
- [x] `RecordStore` interface + in-memory version with a counter per record type
- [x] `POST /services/rest/auth/oauth2/v1/token`: checks client ID/secret, returns a signed JWT (`expires_in: 3600`)
- [x] Auth guard: every other route returns `401` without a valid token
- [x] Record API for `customer`, `vendor`, `invoice`, `customerPayment`, `vendorBill`: POST (204 + `Location`), GET by id, GET `eid:`, PATCH, PUT `eid:` (upsert), DELETE
- [x] Rules: `externalId` unique per type (POST duplicate → 400); references accept `{id}` or `{externalId}` and a missing target → 400 `INVALID_REFERENCE`
- [x] NetSuite-style error body (`type`, `title`, `status`, `o:errorDetails`) from one exception filter
- [x] Invoice money: `total`, `amountPaid`, `amountRemaining`, `status` (`open`/`paidInFull`); saving a `customerPayment` updates its invoice
- [x] SuiteQL endpoint: tokenizer + parser for the grammar in SPEC §7.3, `limit`/`offset`, response with `items`, `count`, `offset`, `totalResults`, `hasMore`
- [x] Chaos: `CHAOS_ERROR_RATE` (random 503s), `CHAOS_LATENCY_MS`, a rate limit returning 429 + `Retry-After`
- [x] Tests: parser (valid and rejected queries), upsert twice = one record, payment updates invoice balance

### Done when

You can get a token, upsert a customer by external ID twice and see one record, and run a SuiteQL `SELECT`.

### How to check

Automated: `npm run test:e2e -w mock-erp` runs exactly these steps over HTTP (see `apps/mock-erp/test/mock-erp.e2e-spec.ts`).

By hand: start it with `npm run start:dev -w mock-erp`, then follow the curl walkthrough in [apps/mock-erp/README.md](../apps/mock-erp/README.md).

### Decisions made while building it

- **Field names** follow NetSuite (`entity`, `tranId`, `tranDate`, `item.items[]`, `expense.items[]`). A payment is `{ customer, payment, currency, apply: { items: [{ doc, amount }] } }`, like NetSuite's `apply` sublist.
- **Item, account and currency** are references (`{ "id": "501" }`) the mock accepts without checking. It doesn't store those lists. Unknown SKUs or categories are caught earlier, by the integration's lookup tables (Phase 2).
- **The mock enforces payment rules too** (overpayment, currency, customer), like NetSuite would. The integration still checks first, so the error is clear and classified as permanent.
- **Unknown fields are rejected** (400), so a typo in a mapper fails loudly instead of being silently ignored.
- **SuiteQL column names come back lowercase** (`tranid`, `amountremaining`), and a reference column returns the referenced record's internal ID, as in real SuiteQL.
- **Rate limit defaults to 25 requests/second** (`RATE_LIMIT_PER_SECOND`, 0 = off). The token endpoint counts toward it.
- **Chaos can also be changed at runtime** with `PUT /mock/chaos` (mock-only, needs a token, never subject to chaos itself).
- **Writes are serialised in-process** so concurrent upserts of the same external ID can't create duplicates. In Phase 3, DynamoDB needs conditional writes and transactions to give the same guarantee across Lambda containers.

---

## Phase 2 — Integration service (local, no queue)

**Goal:** the real product logic, running locally: verify the webhook, map the event to ERP records, push them, classify errors. The webhook calls the worker code directly for now (the queue comes in Phase 3–4).

**Needs AWS?** No.

### Concepts

- **Webhook**: the source app calls *our* URL when something happens (`invoice.created`). We don't poll them.
- **HMAC signature**: the source app and we share a secret. The sender computes `HMAC-SHA256(secret, "<timestamp>.<raw body>")` and sends it in `X-Signature`. We compute the same and compare. If anyone changed one byte of the body, or doesn't know the secret, the values differ → `401`. It must be the **raw** body (exact bytes), because re-serialised JSON may differ by a space.
- **Constant-time compare** (`crypto.timingSafeEqual`): a normal `===` stops at the first wrong character, and an attacker can measure that time to guess the signature byte by byte.
- **Timestamp check (5 minutes)**: stops someone replaying an old captured request.
- **Mapper**: a pure function `sourceEvent → ERP body`. No HTTP inside, so it's easy to unit-test. Lookup tables translate codes (`PLAN-PRO` → item ID `501`).
- **Retryable vs permanent errors** — the most important idea in the project:
  - *Retryable* = might work if we try again later: ERP down (5xx), rate limited (429), timeout, the invoice for this payment hasn't arrived yet.
  - *Permanent* = will fail again no matter how often we try: bad data (400), unknown expense category, payment bigger than the invoice. Retrying just wastes time; a human must fix it.
- **Flow registry**: a map `eventType → handler`. Adding a new event type means adding a schema + handler and registering it, with no change to the worker.

### Tasks

- [x] `lookups/`: typed tables for sku → item ID, expenseCategory → account ID, currency → currency ID
- [x] `errors/`: `RetryableError` and `PermanentError`, each with a `code` and message
- [x] `erp-client/`: get + cache a token until shortly before expiry, refresh once on 401; 10 s timeout; `upsert`, `getByExternalId`, `suiteql`; turn ERP responses into the right error class (5xx/429/timeout/network → retryable, 400 → permanent)
- [x] Credentials via a `SecretsProvider` interface (local: env vars; Phase 4: Secrets Manager)
- [x] `flows/o2c/`: invoice mapper + handler (upsert customer, then invoice)
- [x] `flows/o2c/`: payment handler (invoice missing → retryable; amount > remaining or currency mismatch → permanent; else upsert `customerPayment`)
- [x] `flows/p2p/`: bill mapper + handler (upsert vendor, then vendor bill; unknown category → permanent)
- [x] Flow registry + a `processEvent(event)` function (this becomes the worker's core later)
- [x] `ingest/`: `POST /webhooks/billing` and `/webhooks/procurement`, app created with `rawBody: true`, signature guard, timestamp check, zod validation → 400 on bad payload
- [x] `sync-log/`: repository interface + in-memory version; record `RECEIVED`, `SUCCEEDED`, `FAILED`, `REJECTED`
- [x] `scripts/simulate.ts`: a signing helper + the `happy` command (10 invoices, their payments, 5 bills)
- [x] Unit tests: each mapper (including zero-line invoice, missing optional fields, unknown mapping), signature verification (good, bad, expired), error classification

### Done when

`simulate happy` creates the right records in the mock ERP, and the mapper tests pass.

### How to check

Automated: `npm test -w integration-service` (mappers, signatures, error classes, ERP client, worker) and `npm run test:e2e -w integration-service`, which starts the real mock ERP in-process and sends signed webhooks over HTTP, including every rejection path.

By hand (needs a `.env`, copied from `.env.example`):

1. `npm run build`, then in two terminals `npm run start:dev -w mock-erp` and `npm run start:dev -w integration-service`.
2. `npm run simulate -- happy`. It sends the events, then reads the mock ERP and checks: 10 customers/invoices/payments, 5 vendors/bills, every invoice `paidInFull`. Exit code 0 = pass.
3. Optional: SuiteQL-query the mock yourself (curl walkthrough in [apps/mock-erp/README.md](../apps/mock-erp/README.md)), e.g. `SELECT tranId, status FROM invoice WHERE status = 'paidInFull'`.

### Decisions made while building it

- **The webhook runs the worker inline** through an `EventDispatcher` interface (`InlineDispatcher` now). Phase 3 swaps in an SQS dispatcher; ingest and worker code stay the same. Because it's inline, the `202` response also carries the final `status`. That field goes away once the queue is in.
- **The worker core is already here** (`worker/sync-worker.ts`): skip if `SUCCEEDED`, `PROCESSING` with `attempts + 1`, then `SUCCEEDED` / `RETRYING` / `FAILED`. Phase 4 only wraps it in the SQS handler.
- **No retries in Phase 2.** A retryable failure (rate limit, invoice not there yet) ends as `RETRYING` and stays there until the queue arrives. That's why the simulator waits 200 ms between webhooks (`--delay`): each event costs 2–3 ERP requests and the mock allows 25 per second.
- **Webhook bodies are read as raw bytes** (`express.raw` on `/webhooks`, registered before Nest's JSON parser). The HMAC covers the exact bytes, and malformed JSON reaches our code, so it's logged as `REJECTED` (flow taken from the route, gap 3) instead of being answered by the parser.
- **`X-Timestamp` is unix seconds.** Timestamps more than 5 minutes off in *either* direction are refused, so a forged future timestamp can't stay valid. The signature must be 64 hex characters; anything else is refused without reaching `timingSafeEqual`.
- **A `401` writes nothing to the sync log**, so an unauthenticated caller can't fill our storage. Unknown source → `404`.
- **Event type must match the route**: `bill.approved` on `/webhooks/billing` → `400 WRONG_SOURCE` (REJECTED).
- **A REJECTED payload never overwrites a real record.** If its `id` already exists, the rejection is stored as `<id>:rejected:<uuid>`.
- **Payment idempotency at the business-rule level:** before checking "amount ≤ remaining", the handler looks up the payment by external ID. If the ERP already has it, its earlier amount is added back. Otherwise re-processing an already-applied payment would look like an overpayment and fail permanently.
- **ERP `401` after the one refresh → retryable** (`ERP_AUTH_FAILED`): usually rotated credentials, which a later retry picks up. Other non-429 `4xx` → permanent. Unexpected exceptions (bugs) → retryable, so they end in the DLQ and can be replayed instead of disappearing.
- **Error codes:** our own (`UNKNOWN_SKU`, `UNKNOWN_EXPENSE_CATEGORY`, `UNKNOWN_CURRENCY`, `INVOICE_NOT_FOUND`, `PAYMENT_EXCEEDS_BALANCE`, `PAYMENT_CURRENCY_MISMATCH`, `PAYMENT_CUSTOMER_MISMATCH`, `INVALID_JSON`, `INVALID_PAYLOAD`, `WRONG_SOURCE`), and ERP ones prefixed `ERP_` (`ERP_INVALID_REFERENCE`, `ERP_RATE_LIMITED`, `ERP_TIMEOUT`, `ERP_UNREACHABLE`, …).
- **Sync records already have `history[]`** (gap 4) and a 90-day `ttl`, so the DynamoDB version in Phase 3 is a storage swap.
- **The e2e test imports the mock ERP's `AppModule`** directly. That makes it the contract test from SPEC §12: if the client's URLs or bodies drift from the mock's routes, it fails.

---

## Phase 3 — First deploy to AWS

**Goal:** both stacks deployed. A signed webhook to the real AWS URL returns `202` and the message lands in the SQS queue.

**Needs AWS?** Yes. Finish [Part A.5](#a5-one-time-account-setup-do-this-before-phase-3) first, budget alert included.

### Concepts

- **CDK in practice:** in `infra/` you write code like `new sqs.Queue(this, 'SyncQueue', {...})`. `cdk synth` turns it into a CloudFormation template (to read, not to edit), `cdk diff` shows what would change, `cdk deploy` makes it real, `cdk destroy` deletes it.
- **Two stacks:** `MockErpStack` (the fake NetSuite) and `LedgerBridgeStack` (the product). Kept apart so the product could later point at a real NetSuite and the mock stack is simply not deployed.
- **Lambda basics:** you upload a zip of JavaScript, name the file + exported function (`handler`), set memory and timeout. AWS starts a fresh copy (a **cold start**, slower) when needed and reuses it for later events (**warm**). That's why we create the Nest app once *outside* the handler and reuse it.
- **API Gateway HTTP API:** gives a URL like `https://abc123.execute-api.eu-central-1.amazonaws.com`. Each route (`POST /webhooks/billing`) forwards to a Lambda. **Throttling** caps requests per second so a flood can't run up your bill.
- **SQS in detail:**
  - The ingest Lambda *sends* a message; the worker (Phase 4) *receives* it.
  - When a consumer receives a message, SQS hides it for the **visibility timeout**. If the consumer doesn't delete it in that time (because it crashed or failed), it reappears and is retried.
  - Each time it's received, its **receive count** goes up. The **redrive policy** says "after 4 receives, move it to the DLQ".
  - Rule of thumb: the visibility timeout should be several times the worker Lambda's timeout (AWS suggests 6×), or messages reappear while still being processed.
- **DynamoDB in detail:**
  - Every item has a **partition key** (`pk`) and optionally a **sort key** (`sk`). You look items up by key, fast at any size. There's no `JOIN` and no free-form `WHERE`.
  - To query by another field you add a **GSI** (Global Secondary Index), basically a second copy sorted by that field. Example: `byStatus` lets the dashboard ask "all FAILED records, newest first".
  - **Conditional write**: "put this item *only if* no item with this key exists". Two copies of the same event racing each other: only one wins. This is our event-level dedup.
  - **On-demand** billing = pay per request, no capacity planning.
  - **TTL**: an attribute with a timestamp; DynamoDB deletes the item after that time for free (90-day expiry).
- **IAM roles for Lambdas:** each Lambda gets its own role. CDK makes this easy: `queue.grantSendMessages(ingestFn)` adds exactly "send to this one queue". If a Lambda tries something it wasn't granted, you get `AccessDenied` in its logs. That's the system working.
- **Log retention:** by default CloudWatch keeps Lambda logs forever (and bills for them). We set 7 days.

### Tasks

- [x] Create `infra/` (CDK TypeScript app) as a workspace
- [x] **MockErpStack:** DynamoDB table (`pk` = record type, `sk` = internal ID, GSI on `externalId`, counter items) *(built with external-ID lookup items instead of a GSI, see decisions below)*, Lambda from the rspack bundle in `dist-lambda/` (`lambda.Function` + `Code.fromAsset`, handler `http.handler`, not `NodejsFunction`), HTTP API, outputs the URL
- [x] `DynamoRecordStore` implementing the Phase 1 interface; choose the store from config
- [x] Mock ERP client secret: for now an env var on the *mock* is acceptable (it's the fake ERP, not our product). Our product's copy moves to Secrets Manager in Phase 4. *(The webhook secret already moved in Phase 3.)*
- [x] **LedgerBridgeStack:** SQS queue + DLQ (`maxReceiveCount: 4`), `SyncLog` table (`pk = eventId`, GSI `byStatus` with `sk = updatedAt`, TTL attribute), ingest Lambda (`lambda/http.ts`) behind an HTTP API with throttling
- [x] Ingest now really: conditional write for dedup (repeat → `200`, nothing else), `RECEIVED` record, `SendMessage`, `202 { syncId }`; invalid → `REJECTED` record + `400`
- [x] One IAM role per Lambda, granted only what it needs
- [x] 7-day log retention on every function
- [x] Root script: `npm run deploy` = build everything, then `cdk deploy --all`

### Done when

A signed webhook sent to the real URL returns `202` and the message appears in SQS.

### How to check

1. Once: `npm run aws:secrets` (creates `.env.aws` and the webhook secret) and `npm run cdk -- bootstrap --profile ledgerbridge`.
2. `npm run deploy`. The URLs land in `infra/cdk-outputs.json`.
3. `npm run simulate -- one --aws` sends one signed event to the real URL and expects `202`.
4. Console (Region **eu-north-1**, top right) → SQS → `SyncQueue` → **Send and receive messages** → **Poll for messages**: the event is there.
5. Console → DynamoDB → Tables → the `SyncLog` table → **Explore table items**: one `RECEIVED` item.
6. Console → CloudWatch → Log groups → the ingest Lambda's group: one invocation, no errors.

Automated, no AWS needed: `npm test -w infra` checks the templates (redrive after 4 receives, TTL, 7-day logs, least-privilege grants, throttling).

### Decisions made while building it

- **Region is fixed to eu-north-1** in `infra/bin/app.ts`. Our AWS project (new AWS experience) only allows resources in its selected Region. The CLI login is `aws login --profile ledgerbridge` (12-hour credentials), not `aws configure sso`; IAM Identity Center isn't available in this experience and isn't needed.
- **CDK app runs with plain `node bin/app.ts`** (Node strips the types), so no `ts-node`/`tsx`. `tsconfig` enforces `erasableSyntaxOnly` + `verbatimModuleSyntax` so that stays possible.
- **Mock ERP storage: lookup items instead of a GSI on externalId.** A GSI is updated just *after* a write and can't be read with strong consistency, so a quick retry could miss a record and create a duplicate. Each external ID gets its own item (`pk = <type>#eid`, `sk = <externalId>`), read with `ConsistentRead` and claimed with a conditional write inside the same transaction as the record. Duplicates are impossible even with several Lambda copies at once.
- **Optimistic locking in the mock**: records carry a `version`. A save fails with `409 RCRD_HAS_BEEN_CHANGED` if someone else saved first (e.g. two payments for one invoice at the same moment). The integration treats 409 as retryable.
- **Dynamo/SQS/Secrets Manager are picked from config.** Each app checks for `MOCK_ERP_TABLE_NAME`, `SYNC_LOG_TABLE`, `SYNC_QUEUE_URL` and `WEBHOOK_SECRET_NAME`; CDK sets them on the Lambdas. Unset (local, tests) → in-memory store, inline processing and `.env` secrets, exactly as in Phase 2.
- **Webhook secrets moved to Secrets Manager now, not Phase 4**, so they never sit in Lambda environment variables. `npm run aws:secrets` generates strong values, keeps a local copy in `.env.aws` (gitignored; the simulator signs with it), and creates or updates `ledgerbridge/webhooks`. The stack references the secret by name, so its value is never in a CloudFormation template. The values reach the AWS CLI through a temp file, never the command line.
- **`DynamoSyncLogRepository` is here already** (the plan listed it for Phase 4): ingest's dedup *is* its conditional put.
- **Queue message** = `{ "eventId", "event" }`, with an `eventType` message attribute. The Phase 4 worker reads exactly that.
- **Npm on a slow connection**: `aws-cdk-lib` is a ~40 MB download that npm can't resume. If `npm install` keeps failing with `ECONNRESET`, download the tarball with `curl -C -` (which resumes), `npm cache add` it, then `npm install --prefer-offline`.

---

## Phase 4 — Worker, retries and idempotency

**Goal:** messages are picked up from SQS and pushed to the ERP; duplicates and out-of-order events end with correct, single records.

**Needs AWS?** Yes.

### Concepts

- **SQS → Lambda trigger (event source mapping):** AWS polls the queue for you and calls the worker with a *batch* of up to 5 messages. You don't write polling code.
- **Partial batch failure** (`ReportBatchItemFailures`): normally, if the handler throws, *all 5* messages return to the queue, including the 4 that worked. With this setting, the handler returns the IDs of only the failed messages, and only those are retried.
- **How each error class plays out on SQS:**
  - Success → don't report it → Lambda deletes it from the queue. Sync status `SUCCEEDED`.
  - Retryable → report it as failed → it reappears after the visibility timeout. Status `RETRYING`. After the 4th receive it goes to the DLQ.
  - Permanent → *don't* report it (so it's deleted; retrying won't help). Status `FAILED`.
  - 429 with `Retry-After: 30` → call `ChangeMessageVisibility` to 30 s, so it comes back exactly when the ERP is ready.
- **Two layers of idempotency** (idempotent = doing it twice has the same effect as once):
  1. *Event level:* if the sync record already says `SUCCEEDED`, skip.
  2. *Record level:* every ERP write is an upsert by external ID, so even if layer 1 is bypassed (e.g. the worker crashed after the ERP write but before updating the log), no duplicate appears.
- **Out-of-order events:** a payment arrives before its invoice. The payment handler can't find the invoice → retryable → the message comes back in a bit, by which time the invoice exists → success.
- **Secrets Manager:** the code calls `GetSecretValue` at runtime and caches the result in memory for the life of the warm Lambda. The secret never appears in code, in Git, or in the Lambda's environment variables (anyone with console access could read those).
  - Cost tip: each secret is billed separately. Store related values as JSON in one secret, e.g. `ledgerbridge/webhooks` = `{ "billing": "...", "procurement": "..." }`, `ledgerbridge/erp` = `{ "clientId": "...", "clientSecret": "..." }`, `ledgerbridge/admin` = `{ "apiKey": "..." }`.
  - The Lambda gets an env var with the secret's *name* (not its value), plus an IAM grant to read only that secret.

### Tasks

- [ ] `lambda/worker.ts`: `NestFactory.createApplicationContext()` (no HTTP server), cached between invocations
- [ ] SQS event source: batch size 5, `reportBatchItemFailures: true`; set the queue visibility timeout from the worker timeout
- [ ] Per message: mark `PROCESSING`, increment `attempts`, call `processEvent`, then `SUCCEEDED` (+ `erpRecordType`, `erpRecordId`, `completedAt`) / `RETRYING` / `FAILED` with `lastError`
- [ ] Skip events already `SUCCEEDED`
- [ ] On 429: `ChangeMessageVisibility` using `Retry-After`
- [ ] `DynamoSyncLogRepository` (replacing the in-memory one in AWS)
- [ ] Secrets Manager: create the 3 secrets (via CDK, with generated or manually set values), `SecretsManagerProvider` with in-memory cache, wire into ingest + worker
- [ ] Worker gets the mock ERP URL from config (stack output passed as env var; a URL isn't a secret)
- [ ] Simulator: `duplicates`, `out-of-order`, `bad-signature`, `bad-payload`, `unknown-category`
- [ ] Local integration tests: same event twice → one ERP record; payment before invoice → eventually `SUCCEEDED`

### Done when

`simulate duplicates` and `simulate out-of-order` both end with correct, single records and `SUCCEEDED` status.

### How to check

Run each command, then: DynamoDB `SyncLog` shows `SUCCEEDED` (the out-of-order payment with `attempts` > 1); a SuiteQL query on the deployed mock shows exactly one record per external ID.

> **Minimum strong demo:** Phases 0–4 plus the DLQ alarm from Phase 6.

---

## Phase 5 — CSV import and dead-letter handling

**Goal:** finance can upload a CSV of vendor bills; bad rows are reported, good rows sync. Messages that land in the DLQ are marked `DEAD`.

**Needs AWS?** Yes.

### Concepts

- **S3 basics:** a **bucket** holds **objects** (files) under **keys** (paths like `incoming/bills-nov.csv`). "Folders" are just key prefixes.
- **S3 event notifications:** "when an object is created under `incoming/`, call this Lambda". The Lambda gets the bucket and key, then downloads the file itself.
- **Bucket safety settings:** *Block Public Access* (nothing in this bucket can ever be made public), *encryption at rest* (files are encrypted on disk), and an IAM policy so uploads are allowed only under `incoming/`.
- **Moving a file** in S3 = copy to the new key + delete the old one. There's no rename.
- **Deterministic event IDs:** the ID is `csv:<sha256 of file>:<bill_number>`. Upload the same file again → same IDs → the dedup from Phase 3 ignores them. Same input, same IDs: that's what makes re-uploads safe.
- **DLQ consumer:** a tiny Lambda triggered by the DLQ. Its only job: set the sync record to `DEAD` so the dashboard shows it. The message stays in the DLQ (that's what the alarm watches) until replayed.

### Tasks

- [ ] S3 bucket: block public access, encryption, `enforceSSL`, notification on `incoming/` prefix → CSV Lambda
- [ ] `lambda/csv.ts`: download, hash, parse rows, validate each row, group by `bill_number`, build one `bill.approved` per bill, write `RECEIVED` + enqueue (same path as ingest)
- [ ] Invalid rows → `rejected/<file>.errors.csv` (original columns + `reason`)
- [ ] Move the file to `processed/`
- [ ] DLQ Lambda: on each message, set status `DEAD`
- [ ] Simulator `csv`: upload a sample with a few invalid rows (bad date, missing amount, unknown category)
- [ ] Unit tests: CSV row parsing and grouping, deterministic IDs

### Done when

`simulate csv` creates the valid bills and writes a rejected-rows file.

### How to check

Console → S3 → bucket: the file is in `processed/`, an `.errors.csv` is in `rejected/`. Mock ERP has the valid bills. Upload the same file again: nothing new is created.

---

## Phase 6 — Logs, metrics and alarms

**Goal:** you get an email when things break, and can trace one event across every Lambda.

**Needs AWS?** Yes.

### Concepts

- **CloudWatch Logs:** everything a Lambda prints goes to its **log group**. Plain text is hard to search; **structured JSON** logs (one JSON object per line) let you filter on fields.
- **Logs Insights:** a query language over log groups. Example — trace one event end to end:
  ```
  fields @timestamp, level, message, attempt
  | filter eventId = "evt_01HZX..."
  | sort @timestamp asc
  ```
- **Powertools for AWS Lambda:** an AWS library that does structured logging and metrics properly. `Logger` adds context fields (`eventId`, `flow`, …) to every line; `Metrics` publishes custom metrics cheaply (as specially formatted log lines, the "Embedded Metric Format").
- **Metrics:** numbers over time, e.g. `SyncFailed` with dimension `flow=O2C`. A **dimension** is a label you can filter or split by.
- **Alarms:** a rule like "if `DLQ ApproximateNumberOfMessagesVisible` > 0 for 1 period of 1 minute → ALARM". On state change it sends to an SNS topic.
- **SNS email subscription:** after deploy, AWS emails you a **confirmation link**. Nothing arrives until you click it (and check spam).
- **Redaction:** logs must never contain secrets, tokens, or full emails. Mask emails (`a***@cedar.example`) before logging and never log headers wholesale.

### Tasks

- [ ] Powertools `Logger` in every Lambda; `eventId`, `flow`, `eventType`, `attempt` appended per message
- [ ] Redaction helper for emails; never log `Authorization` or signature headers
- [ ] Powertools `Metrics`: `SyncSucceeded`, `SyncFailed`, `SyncRetried`, `SyncDurationMs` (dimension `flow`), namespace `LedgerBridge`
- [ ] SNS topic + email subscription (address from CDK context/config, not hard-coded)
- [ ] Alarms: DLQ visible > 0; `SyncFailed` ≥ 5 in 5 min; worker errors > 0 for 2 periods; oldest message age > 10 min; (`ReconciliationMismatches` > 0 is added in Phase 8)
- [ ] CloudWatch dashboard: queue depth, success vs failure, duration p50/p95, DLQ depth
- [ ] Chaos switch on the deployed mock (env var via CDK context, or an admin endpoint)

### Done when

With `CHAOS_ERROR_RATE=1`, messages reach the DLQ and you receive the alarm email.

### How to check

Turn chaos on, send a few events, wait: each message is retried 4 times (watch `RETRYING` in DynamoDB), moves to the DLQ, becomes `DEAD`, the alarm turns red in CloudWatch → Alarms, and the email arrives.

---

## Phase 7 — Admin API and dashboard

**Goal:** an operator can see every sync, read the error, and replay failures from a web page.

**Needs AWS?** The admin API runs on AWS; the dashboard runs on your machine.

### Concepts

- **Admin API:** a few extra routes on the integration service, protected by an API key header (the key lives in Secrets Manager).
- **Why server-side fetching:** anything the browser downloads, the user can read. If the browser called the admin API, the key would be visible in DevTools. Next.js **server components** and **route handlers** run on the Next.js server, so the key stays there and the browser only receives HTML/JSON.
- **Cursor pagination:** DynamoDB returns a page plus a `LastEvaluatedKey`. We hand that to the browser (encoded) as `cursor`; the next request passes it back. No page numbers, because DynamoDB can't jump to "page 7".
- **Replay:** load the stored payload, reset `attempts` and status to `RECEIVED`, send the message to the main queue again. It skips the ingest dedup on purpose (the event ID already exists; that's the point). Then purge the old copy from the DLQ if it's still there.

### Tasks

- [ ] `admin/` module + API key guard
- [ ] `GET /admin/syncs?status=&flow=&q=&cursor=` (newest first; status via `byStatus` GSI)
- [ ] `GET /admin/syncs/{eventId}` (full detail incl. payload, error, history)
- [ ] `POST /admin/syncs/{eventId}/replay` (only `FAILED`/`DEAD`)
- [ ] `GET /admin/stats` (counts per status and flow, last 24 h; DLQ depth via SQS `GetQueueAttributes`)
- [ ] Add a `history[]` list of `{ status, at, error? }` to sync records (needed for the timeline)
- [ ] `apps/dashboard` (Next.js App Router): Overview (tiles, refresh every 15 s), Syncs (table, filters, search, cursor), Sync detail (timeline, payload, error, ERP ID, Replay button)
- [ ] Admin URL + key in the dashboard's `.env.local` (git-ignored), read only on the server

### Done when

You find the dead events on the dashboard, turn chaos off, click Replay, and they succeed.

---

## Phase 8 — Reconciliation, docs and CI

**Goal:** a nightly check that the ERP actually holds what we think we synced; documentation; automated checks on every push.

**Needs AWS?** Yes, plus a GitHub repo for CI.

### Concepts

- **Why reconcile when everything says SUCCEEDED:** someone might delete or edit a record directly in the ERP, a bug might write the wrong thing, or a write might succeed on the ERP side while our log update failed. Finance needs both sides to agree. Reconciliation compares them.
- **EventBridge schedule:** a cron rule (`cron(0 2 * * ? *)` = 02:00 UTC daily) that calls the reconcile Lambda.
- **GitHub Actions:** YAML in `.github/workflows/` that GitHub runs on each push: install, lint, typecheck, test. The deploy job is manual (`workflow_dispatch`) and needs AWS credentials. Use GitHub's OIDC connection to AWS (a role GitHub can assume) rather than storing access keys in GitHub.

### Tasks

- [ ] `lambda/reconcile.ts`: last 24 h `SUCCEEDED` records vs SuiteQL for invoices, payments, bills in the same window; list missing on either side
- [ ] Publish `ReconciliationMismatches` metric + alarm; store a summary item for the dashboard Overview
- [ ] EventBridge rule at 02:00 UTC (plus a way to run it by hand for testing)
- [ ] Simulator `load --count 200`
- [ ] Contract test: the ERP client's requests match the mock's routes
- [ ] Coverage ≥ 80% on `flows/` and `erp-client/`
- [ ] `.github/workflows/ci.yml` (lint, typecheck, test) and a manual deploy workflow
- [ ] `README.md`: what it is, diagram, deploy, simulator, screenshots, "How this maps to real NetSuite"
- [ ] `docs/RUNBOOK.md`: per alarm: meaning, the Logs Insights query, how to fix and replay
- [ ] `docs/ADDING_AN_INTEGRATION.md`: schema → mapper → handler → secret → tests

### Done when

Deleting an invoice directly in the mock ERP causes the next reconciliation run to flag it, and README, RUNBOOK and ADDING_AN_INTEGRATION are written.

---

## Gaps in the spec and how we handle them

1. **Replay vs dedup.** Ingest refuses a repeated event ID; replay re-sends the same ID. So replay sends straight to SQS and skips the ingest dedup.
2. **Emails in storage vs logs.** The payload kept in DynamoDB keeps the full email (needed for replay); logs never show it.
3. **Flow of a rejected payload.** If the body can't be parsed there's no `type`; take the flow from the route (billing → O2C, procurement → P2P).
4. **Timeline needs history.** The spec's sync record has no status history; we add `history[]`.

---

## Glossary

| Term | Meaning |
|---|---|
| **202 Accepted** | "Got it, will process later." Used because the real work happens behind the queue |
| **Cold start** | The extra delay when Lambda starts a new copy of your function |
| **Conditional write** | A DynamoDB write that only happens if a condition holds (e.g. key doesn't exist yet) |
| **DLQ** | Dead-letter queue: where messages go after too many failed attempts |
| **External ID** | The source system's ID stored on the ERP record; the key for upserts |
| **GSI** | Global Secondary Index: a DynamoDB index on a different key |
| **HMAC** | A signature made with a shared secret; proves who sent a message and that it wasn't changed |
| **Idempotent** | Doing it twice has the same effect as once |
| **JWT** | JSON Web Token: a signed token carrying claims like "who" and "expires when" |
| **O2C / P2P** | Order-to-Cash (getting paid by customers) / Procure-to-Pay (paying suppliers) |
| **Redrive policy** | SQS rule moving messages to the DLQ after N receives |
| **Upsert** | Update if it exists, insert if not |
| **Visibility timeout** | How long SQS hides a message after a consumer receives it |

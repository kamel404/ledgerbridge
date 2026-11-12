# integration-service

The product: webhook ingest, mapping, ERP client, worker, sync log, admin API (SPEC §8).

## Commands

Run from the repo root (`-w integration-service` targets this app) or from this folder.

| Command | What it does |
|---|---|
| `npm run start:dev -w integration-service` | Local server with reload on http://localhost:3000 (reads the root `.env`) |
| `npm test -w integration-service` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e -w integration-service` | HTTP tests against the full app plus an in-process mock ERP (`test/*.e2e-spec.ts`) |
| `npm run typecheck -w integration-service` | TypeScript check, no output |
| `npm run build:lambda -w integration-service` | Lambda bundle in `dist-lambda/` |
| `npm run simulate -- <command> [--aws]` (root) | Fake source apps: `happy`, `duplicates`, `out-of-order`, `bad-signature`, `bad-payload`, `unknown-category`. Header of `scripts/simulate.ts` explains each |

## How an event flows

On AWS the webhook and the worker are two Lambdas with the SQS queue between them. Locally (no `SYNC_QUEUE_URL`) the `InlineDispatcher` calls the worker straight away, so the same code runs in one process.

```
POST /webhooks/{billing|procurement}
  │  express.raw: body kept as exact bytes
  ▼
WebhookSignatureGuard      unknown source → 404; bad/missing/expired signature → 401 (nothing logged)
  ▼
IngestService              not JSON / fails zod / wrong source → REJECTED + 400
                           event ID seen before → 200 { duplicate: true }
                           else RECEIVED, then dispatch
  ▼
SqsDispatcher (AWS)        sends {eventId, event} to SyncQueue, webhook answers 202
  or InlineDispatcher      (local) runs the worker right away
  ▼
lambda/worker.ts (AWS)     SQS batch of up to 5 → SqsBatchHandler, one message at a time
  ▼
SyncWorker                 already SUCCEEDED → skip; PROCESSING, attempts + 1
  ▼
FlowRegistry.processEvent  invoice.created → InvoiceCreatedHandler
                           payment.received → PaymentReceivedHandler
                           bill.approved → BillApprovedHandler
  ▼
ErpClient                  OAuth token cache, PUT /{type}/eid:{externalId}, 10 s timeout
  ▼
SUCCEEDED | RETRYING (retryable error) | FAILED (permanent error)
  ▼
SqsBatchHandler (AWS)      SUCCEEDED / FAILED → message deleted
                           RETRYING → reported in batchItemFailures, back on the queue after
                                      Retry-After, or 10 s / 30 s / 90 s; 4th failure → DLQ
```

## Where things are

| Folder | Contents |
|---|---|
| `src/ingest/` | Webhook controller, signature guard + `signature.ts` (HMAC, timestamp), raw-body setup, `EventDispatcher` |
| `src/flows/` | `FlowHandler` interface, `FlowRegistry`, `o2c/` (invoice, payment), `p2p/` (bill). Mappers are pure functions |
| `src/erp-client/` | `ErpClient` and `erp-errors.ts` (HTTP status → retryable/permanent) |
| `src/errors/` | `RetryableError`, `PermanentError`, `classifyError` |
| `src/lookups/` | SKU → item, expense category → account, currency → currency ID |
| `src/sync-log/` | `SyncRecord`, repository interface, in-memory and DynamoDB repositories, `SyncLogService` |
| `src/worker/` | `SyncWorker` (one event in, status out), `SqsBatchHandler` (SQS batch → worker, retry delays), `WorkerAppModule` (the worker Lambda's root module) |
| `src/lambda/` | Lambda entry points: `http.ts` (API Gateway → Nest app), `worker.ts` (SQS → `SqsBatchHandler`) |
| `src/secrets/` | `SecretsProvider` interface, env-var version (local) and Secrets Manager version (AWS) |
| `src/config/` | Non-secret settings from env vars (`ERP_BASE_URL`, timeouts) |

## Adding an event type

1. Add its zod schema to `packages/shared/src/events.ts` (and to `LedgerEvent`, `EVENT_FLOW`).
2. Write a mapper (pure function) and a handler implementing `FlowHandler<'your.type'>` under `src/flows/`.
3. Add the handler to `HANDLERS` in `src/flows/flows.module.ts`.

The worker and ingest code don't change.

## Sending a webhook by hand

Signature: `X-Signature` = hex `HMAC-SHA256(secret, "<X-Timestamp>.<raw body>")`, with `X-Timestamp` in unix seconds. In Git Bash:

```bash
BODY='{"id":"evt_demo_1","type":"bill.approved","occurredAt":"2026-11-11T11:00:00Z","data":{"billNumber":"BILL-DEMO","vendor":{"id":"VEN-DEMO","name":"Demo Supplies"},"billDate":"2026-11-10","currency":"USD","lines":[{"expenseCategory":"OFFICE_SUPPLIES","amount":12.5}]}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac local-procurement-secret -hex | sed 's/.*= //')
curl -s -X POST localhost:3000/webhooks/procurement \
  -H "Content-Type: application/json" -H "X-Timestamp: $TS" -H "X-Signature: $SIG" --data-binary "$BODY"
# {"syncId":"evt_demo_1","status":"SUCCEEDED"}
```

## How it runs on Lambda

- `src/app.factory.ts` builds the Nest app. Both `src/main.ts` (local server) and `src/lambda/http.ts` (Lambda) use it, so they behave the same, including the raw-body setup for webhooks.
- `src/lambda/http.ts` wraps the app with `@codegenie/serverless-express` and caches it between invocations (cold start once, then warm).
- `npm run build:lambda` bundles with **rspack**, not webpack: Nest 12's webpack builder refuses ESM projects. rspack keeps the decorator metadata that dependency injection needs. Settings and reasons are in `rspack.config.cjs`.
- Output: `dist-lambda/http.js` and `dist-lambda/worker.js`, one file per Lambda with every dependency inside, plus a `package.json` marking them CommonJS. Lambda handlers: `http.handler`, `worker.handler`.
- `src/lambda/worker.ts` starts Nest with `createApplicationContext` (dependency injection, no HTTP server) and caches it like the HTTP one.

Try the bundle locally without AWS (from the repo root, Git Bash):

```bash
npm run build:lambda
MSYS_NO_PATHCONV=1 npm run invoke:lambda -- apps/integration-service/dist-lambda/http.js GET /health
```

`MSYS_NO_PATHCONV=1` stops Git Bash from rewriting `/health` into a Windows path. It isn't needed in PowerShell.

# infra

The AWS CDK app: TypeScript code that describes every AWS resource. `cdk deploy` turns it into a CloudFormation template and creates or updates the resources. `cdk destroy` deletes them.

If you know DigitalOcean: instead of creating a droplet, a database and a firewall by clicking, you describe them here, and one command creates them all the same way every time (like Terraform).

## Stacks

A *stack* is a group of resources deployed and deleted together.

| Stack | What's in it |
|---|---|
| `MockErpStack` | The fake NetSuite: a DynamoDB table, one Lambda running the Nest app, a public HTTPS URL (API Gateway) |
| `LedgerBridgeStack` | The product: webhook URL (API Gateway) → ingest Lambda, and CSV bucket (S3) → CSV Lambda, both → `SyncLog` table + `SyncQueue` (SQS) → worker Lambda → ERP. Dead-letter queue → DLQ Lambda (marks `DEAD`) |

Both are in Region **eu-north-1**, the only Region our AWS project allows.

```
                        LedgerBridgeStack
 source app ──HTTPS──▶ API Gateway ──▶ Ingest Lambda ──┐
  (signed webhook)     20 req/s max                      ├──▶ SyncLog (DynamoDB)   RECEIVED / REJECTED, dedup
 finance ──upload──▶ S3 incoming/*.csv ──▶ CSV Lambda ───┤
                     (moved to processed/,               │
                      bad rows in rejected/)             └──▶ SyncQueue (SQS) ──▶ Worker Lambda ──▶ SyncLog
                                                               │          batches of 5,     SUCCEEDED / RETRYING / FAILED
                                                               │          max 5 at once          │
                                                               └─ after 4 failures ─▶ SyncDLQ ──▶ DLQ Lambda: DEAD
                                                                                                 │ HTTPS + OAuth
                        MockErpStack                                                             ▼
                       API Gateway ──▶ Mock ERP Lambda ──▶ Records (DynamoDB)  ◀──────────────────┘
```

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `npm run aws:secrets` | Once, before the first deploy: makes `.env.aws` (gitignored) and stores the two secrets (`ledgerbridge/webhooks`, `ledgerbridge/erp`) in Secrets Manager. Safe to re-run |
| `npm run synth` | Builds the Lambda bundles and prints the CloudFormation templates, without touching AWS |
| `npm run cdk -- diff --profile ledgerbridge` | Shows what a deploy would change |
| `npm run deploy` | Builds the bundles and deploys both stacks. Writes the URLs to `infra/cdk-outputs.json` |
| `npm run destroy` | Deletes both stacks (tables and their data included). Then `npm run aws:secrets -- --delete` removes the secrets |
| `npm run chaos -- <0..1>` | Redeploys only the mock ERP with that share of requests failing (503). `npm run chaos -- 0` (or any `npm run deploy`) turns it off |
| `npm test -w infra` | Checks the templates (DLQ after 4 tries, 7-day logs, permissions, ...) without deploying |

The first deploy in an account needs `npm run cdk -- bootstrap --profile ledgerbridge` once. It creates a small S3 bucket and IAM roles that CDK uses to upload the Lambda code.

If AWS says your credentials expired: `aws login --profile ledgerbridge` (they last 12 hours).

## Design notes

- **Lambda code**: `lambda.Function` + `Code.fromAsset(apps/<app>/dist-lambda)`, the rspack bundle, not `NodejsFunction` (its esbuild step would drop the decorator metadata Nest needs). Node 24, arm64 (cheaper), 512 MB.
- **Permissions**: every Lambda has its own IAM role, and only `grant*()` calls add permissions. Anything else fails with `AccessDenied`.
  - Ingest: write the SyncLog table, *send* to the queue (not receive or delete), read `ledgerbridge/webhooks`.
  - Worker: receive/delete/change visibility on the queue (added by the event source), read and write the SyncLog table, read `ledgerbridge/erp`. It can't send to the queue or read the webhook secrets.
  - CSV import: read and delete in `incoming/`, write to `processed/` and `rejected/`, write the SyncLog table, send to the queue.
  - DLQ handler: consume the DLQ, read and write the SyncLog table. Nothing else.
  - Admin API (same bundle as ingest, own function): read and write the SyncLog table, send to the queue (replay), read queue depths, read `ledgerbridge/admin`. API Gateway sends only `/admin/*` to it.
- **CSV bucket**: Block Public Access, S3-managed encryption, HTTPS only, ACLs off. A bucket policy refuses uploads anywhere but `incoming/` (except from the CSV Lambda). Files expire after 90 days (`incoming/` after 30). `.csv` files created under `incoming/` trigger the CSV Lambda. `cdk destroy` empties and deletes it (CDK adds a small helper Lambda for that, and one that wires up the notification).
- **DLQ handler**: the trigger removes each message from the DLQ once its record is `DEAD`; the record keeps the event for replay. So alarms watch messages *arriving* in the DLQ (Phase 6), not messages waiting there.
- **Worker trigger**: an SQS event source with batch size 5, `ReportBatchItemFailures` (only failed messages return to the queue) and `maxConcurrency: 5` (at most 5 worker copies at once, so a burst can't flood the ERP). Worker timeout 30 s; the queue's visibility timeout is 6× that (180 s).
- **ERP URL**: the worker gets the mock ERP's URL from `MockErpStack` (a cross-stack reference). Pointing at a real NetSuite later means passing its URL instead.
- **Secrets**: LedgerBridge's secrets live in Secrets Manager (`ledgerbridge/webhooks` for ingest, `ledgerbridge/erp` for the worker). Each Lambda gets only the secret's name. The mock ERP's own client secret is a Lambda environment variable, acceptable only because it's the fake ERP.
- **Secret lifecycle**: `npm run aws:secrets` creates the secrets outside CDK, so their values never appear in a CloudFormation template; the stack only references them by name.
- **Monitoring** (`lib/monitoring.ts`): SNS topic `LedgerBridgeAlarms` with an email subscription (`ALARM_EMAIL` in `.env.aws`; confirm the link AWS emails you). Alarms, each notifying on ALARM and OK: `DeadLetters` (a message arrived in the DLQ), `SyncFailures` (≥ 5 permanent failures in 5 min), `WorkerErrors` (worker Lambda errors 2 minutes in a row), `QueueBacklog` (oldest message > 10 min), `CsvImportErrors`. Dashboard **LedgerBridge** and saved Logs Insights query *LedgerBridge/Trace one event*.
- **Logs and metrics**: the LedgerBridge Lambdas write JSON logs (Powertools, service `ledgerbridge`) and custom metrics in namespace `LedgerBridge` with dimensions `service` + `flow`.
- **Costs**: DynamoDB on demand, SQS and API Gateway per request, logs kept 7 days, API throttled at 20 requests/s. Idle cost is about $1.20/month (three secrets at $0.40 each).
- **Delete everything**: tables and log groups use `RemovalPolicy.DESTROY`, so `cdk destroy` leaves nothing behind. Fine for a learning project; a real system would keep (`RETAIN`) its data tables.
- **No ERP calls in ingest**: on AWS, ingest only writes the sync record and sends to SQS (SPEC §8.1); the worker does the ERP calls. Locally the same code processes events inline because no queue is configured.

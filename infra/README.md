# infra

The AWS CDK app: TypeScript code that describes every AWS resource. `cdk deploy` turns it into a CloudFormation template and creates or updates the resources. `cdk destroy` deletes them.

If you know DigitalOcean: instead of creating a droplet, a database and a firewall by clicking, you describe them here, and one command creates them all the same way every time (like Terraform).

## Stacks

A *stack* is a group of resources deployed and deleted together.

| Stack | What's in it |
|---|---|
| `MockErpStack` | The fake NetSuite: a DynamoDB table, one Lambda running the Nest app, a public HTTPS URL (API Gateway) |
| `LedgerBridgeStack` | The product: webhook URL (API Gateway) → ingest Lambda → `SyncLog` table + `SyncQueue` (SQS) with a dead-letter queue |

Both are in Region **eu-north-1**, the only Region our AWS project allows.

```
                        LedgerBridgeStack
 source app ──HTTPS──▶ API Gateway ──▶ Ingest Lambda ──▶ SyncLog (DynamoDB)   RECEIVED / REJECTED, dedup
  (signed webhook)     20 req/s max          │
                                             └──────────▶ SyncQueue (SQS) ──▶ worker (Phase 4)
                                                               └─ after 4 failures ─▶ SyncDLQ

                        MockErpStack
                       API Gateway ──▶ Mock ERP Lambda ──▶ Records (DynamoDB)
```

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `npm run aws:secrets` | Once, before the first deploy: makes `.env.aws` (gitignored) and stores the webhook secret in Secrets Manager |
| `npm run synth` | Builds the Lambda bundles and prints the CloudFormation templates, without touching AWS |
| `npm run cdk -- diff --profile ledgerbridge` | Shows what a deploy would change |
| `npm run deploy` | Builds the bundles and deploys both stacks. Writes the URLs to `infra/cdk-outputs.json` |
| `npm run destroy` | Deletes both stacks (tables and their data included). Then `npm run aws:secrets -- --delete` removes the secret |
| `npm test -w infra` | Checks the templates (DLQ after 4 tries, 7-day logs, permissions, ...) without deploying |

The first deploy in an account needs `npm run cdk -- bootstrap --profile ledgerbridge` once. It creates a small S3 bucket and IAM roles that CDK uses to upload the Lambda code.

If AWS says your credentials expired: `aws login --profile ledgerbridge` (they last 12 hours).

## Design notes

- **Lambda code**: `lambda.Function` + `Code.fromAsset(apps/<app>/dist-lambda)`, the rspack bundle, not `NodejsFunction` (its esbuild step would drop the decorator metadata Nest needs). Node 24, arm64 (cheaper), 512 MB.
- **Permissions**: every Lambda has its own IAM role, and only `grant*()` calls add permissions. Ingest can write the SyncLog table, *send* to the queue (not receive or delete), and read the one webhook secret. Anything else fails with `AccessDenied`.
- **Secrets**: LedgerBridge's webhook secret lives in Secrets Manager (`ledgerbridge/webhooks`). The Lambda gets only the secret's name. The mock ERP's client secret is a Lambda environment variable, acceptable only because it's the fake ERP.
- **Secret lifecycle**: `npm run aws:secrets` creates the secret outside CDK, so its value never appears in a CloudFormation template; the stack only references it by name.
- **Costs**: DynamoDB on demand, SQS and API Gateway per request, logs kept 7 days, API throttled at 20 requests/s. Idle cost is about $0.40/month (the secret).
- **Delete everything**: tables and log groups use `RemovalPolicy.DESTROY`, so `cdk destroy` leaves nothing behind. Fine for a learning project; a real system would keep (`RETAIN`) its data tables.
- **No ERP calls in ingest**: on AWS, ingest only writes the sync record and sends to SQS (SPEC §8.1). Locally the same code processes events inline because no queue is configured.

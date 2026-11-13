# Runbook

What to do when a LedgerBridge alarm email arrives. Every alarm is named `LedgerBridge-<Name>` and also shows on the CloudWatch dashboard **LedgerBridge** (top row).

## Before you start

- **Region:** everything is in **eu-north-1**. If the console shows nothing, check the Region picker first.
- **Credentials:** `aws login --profile ledgerbridge` (they last 12 hours).
- **Tools you will use:**
  - The operator **dashboard** (`WebDashboardUrl` in `infra/cdk-outputs.json`): find events, read errors, click **Replay**.
  - **CloudWatch Logs Insights**, with the saved query **LedgerBridge/Trace one event**. It already searches every LedgerBridge Lambda log group: paste an event ID and run it to see that event's full story across ingest, worker and DLQ handler.
  - `npm run chaos -- 0` makes sure the mock ERP isn't still being forced to fail from a test.

### Two queries worth keeping

Recent errors from every LedgerBridge Lambda (select all `LedgerBridgeStack-*` log groups):

```
fields @timestamp, @log, context, message, eventId, error.message
| filter level = "ERROR"
| sort @timestamp desc
| limit 50
```

Failures grouped by reason, to see whether it's one cause or many:

```
fields @timestamp
| filter level in ["WARN", "ERROR"]
| stats count(*) as events by message
| sort events desc
```

### Error codes you'll see on the dashboard

| Code | Meaning | Retried? |
|---|---|---|
| `ERP_RATE_LIMITED` | ERP said 429 | Yes, after its `Retry-After` |
| `ERP_SERVER_ERROR`, `ERP_<code>` from a 5xx | ERP had a problem | Yes |
| `ERP_AUTH_FAILED` | OAuth token refused | Yes (a new token is fetched) |
| `ERP_BAD_REQUEST`, `ERP_<code>` from a 4xx | ERP refused the data | No: `FAILED` |
| `UNKNOWN_EXPENSE_CATEGORY`, `UNSUPPORTED_EVENT_TYPE`, … | Our mapping can't handle the data | No: `FAILED` |
| `UNEXPECTED_ERROR` | A bug or something unforeseen | Yes, then `DEAD` |

Retried events wait 10 s, 30 s, 90 s. After the 4th failed try they become `DEAD`.

### How replay works

Replay (dashboard button, or `POST /admin/syncs/<eventId>/replay`) puts the stored original payload back on the queue. It only works for `FAILED` and `DEAD` events. It is always safe: the worker upserts by external ID, so replaying an event that actually reached the ERP doesn't create a second record. **Fix the cause first**, or the event just fails again.

---

## DeadLetters

**Means:** at least one event failed 4 times and is now `DEAD`. Its payload is kept.

**Look:**
1. Dashboard → Overview → click the **DEAD** tile. Open each event and read **Error** and the **Timeline**.
2. If the reason isn't clear, run **Trace one event** with its event ID.

**Usual causes and fixes:**
- **ERP was down or slow** (`ERP_SERVER_ERROR`, timeouts, many events at the same time). Check the ERP is back (for the mock: `npm run chaos -- 0`, then `npm run simulate -- happy --aws`). Then replay every DEAD event.
- **Payment arrived long before its invoice** (payment events only, `INVOICE_NOT_FOUND`). Find the invoice event; once it's `SUCCEEDED`, replay the payment.
- **`UNEXPECTED_ERROR`**: a bug. Read the stack trace in the logs, fix, deploy, then replay.

## SyncFailures

**Means:** 5 or more events failed permanently in 5 minutes. They were not retried, because retrying wouldn't help.

**Look:** Dashboard → Syncs, filter **Status = FAILED**. Usually they all share one code.

**Usual causes and fixes:**
- **`UNKNOWN_EXPENSE_CATEGORY` / unknown currency:** the source app sent a value our lookup tables don't know. Add it to the mapping in `apps/integration-service/src/flows/`, deploy, then replay. If the value is simply wrong, have the source app resend a corrected event (a new event ID).
- **`ERP_*` 4xx** (for example a payment larger than the invoice balance): the data is wrong for the ERP. Fix it at the source. Replaying the same payload will fail the same way.
- **A burst of the same error after a deploy:** probably a mapper bug. Roll back (redeploy the previous commit) and replay.

## WorkerErrors

**Means:** the worker Lambda itself crashed or timed out 2 minutes in a row. Normal sync failures don't count here; this is the code or the runtime failing.

**Look:** Lambda console → the `Worker` function → **Monitor** → "View CloudWatch logs". Or the "recent errors" query above. Look for `Worker crashed`, `Task timed out`, out-of-memory.

**Fix:**
- After a deploy: roll back, then investigate.
- Timeouts: is the ERP very slow? Check the CloudWatch dashboard graph "Time in the ERP per event".
- Messages are not lost: they go back on the queue and, after 4 tries, to the DLQ. Replay them once fixed.

## QueueBacklog

**Means:** a message has waited in the sync queue more than 10 minutes. Events are arriving faster than they are processed, or processing is stuck.

**Look:** CloudWatch dashboard → queue depth and worker invocations. Lambda → Worker → **Throttles**.

**Usual causes and fixes:**
- **Lambda concurrency limit.** This project's account-wide limit is 10 (the default for new accounts), shared by every function. Under load the worker gets throttled. Request an increase in **Service Quotas → AWS Lambda → Concurrent executions**.
- **ERP rate-limiting** (`ERP_RATE_LIMITED` in the logs): the backlog clears by itself. Nothing to do unless it lasts.
- **The worker is failing** (see WorkerErrors).

The alarm clears when the oldest message is younger than 10 minutes.

## CsvImportErrors

**Means:** the CSV import Lambda crashed. This is not about bad rows: those go to `rejected/<file>.errors.csv` and don't trigger the alarm.

**Look:** S3 → the CSV bucket. The file is probably still under `incoming/` (it moves to `processed/` only on success). Read the `CsvImport` function's logs.

**Fix:** usual reasons are a file that isn't CSV, or the wrong encoding. Fix the file and upload it again to `incoming/`. Uploading the same file again is safe: event IDs come from the file's hash, so bills that already synced aren't duplicated.

## ReconciliationMismatches

**Means:** the nightly check (02:00 UTC) found records that differ between our sync log and the ERP. The summary is on the dashboard Overview.

**Look:** dashboard Overview → **Last reconciliation** tile. Or in the `Reconcile` function's logs, lines like `Mismatch MISSING_IN_ERP: invoice INV-1042 (event …)`.

| Kind | Meaning | Fix |
|---|---|---|
| `MISSING_IN_ERP` | We say `SUCCEEDED`, but the ERP doesn't have it (someone deleted it, or a write was lost) | Replay the event shown. Upsert recreates it |
| `ERP_ID_CHANGED` | The ERP has the record under a different internal ID than we stored (deleted and recreated by hand) | Check with finance which one is right; replay if ours should win |
| `MISSING_IN_LEDGERBRIDGE` | The ERP has a record with our external ID that we have no successful sync for | Someone created it by hand in the ERP, or our log write failed. Check with finance |

Re-run the check by hand after fixing: `npm run reconcile` (add `-- --include-recent` to include the last 5 minutes).

The alarm only evaluates when a reconciliation runs, so it stays red until the next run finds no mismatches.

## ReconcileErrors

**Means:** the reconciliation run itself failed, even after EventBridge Scheduler retried it twice. No result was stored for that night.

**Look:** the `Reconcile` function's logs.

**Fix:** usually the ERP was unreachable at 02:00 or the OAuth secret changed. Once fixed, run `npm run reconcile` to get the missing result.

---

## Not an alarm, but common

- **Webhook senders get `503`:** API Gateway or Lambda throttling, usually the concurrency limit of 10 (see QueueBacklog). Senders should retry. The simulator does.
- **Webhook senders get `401`:** wrong HMAC secret or a clock more than 5 minutes off. Secrets are in Secrets Manager `ledgerbridge/webhooks`.
- **Everything suddenly says Access Denied:** check **AWS Settings → Billing**. A spend limit pauses the project when it's reached.
- **No alarm emails:** the SNS subscription must be confirmed (the first email has a link), and check spam.

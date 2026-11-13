# Adding an integration

How to teach LedgerBridge a new kind of event. The example used throughout is a hypothetical **`credit.issued`** event from the billing app that becomes a NetSuite `creditMemo`. Swap in your own names.

The ingest, queue, worker, retry, dead-letter and replay code never changes: they work for any event type the registry knows. You only add the pieces below.

## Decide first

| Question | If yes, also do |
|---|---|
| Does it come from an existing source app (`billing`, `procurement`)? | Nothing extra |
| Is it a **new source app** with its own webhook URL? | [Step 6](#6-a-new-source-app-only) |
| Does it write an ERP record type we don't use yet? | [Step 3](#3-the-erp-record-type) |
| Should the nightly reconciliation check it? | [Step 7](#7-reconciliation-optional) |
| Is it a new business flow (not O2C or P2P)? | Add it to `Flow` in `packages/shared/src/enums.ts` and to `FLOWS` in `infra/lib/monitoring.ts`, so the metrics and alarms include it |

## 1. The event schema

`packages/shared/src/events.ts`: a zod schema is the contract with the sender. Anything that doesn't match is refused at the front door with `400` and shown as `REJECTED`, so it never reaches the worker.

```ts
export const CreditIssuedEvent = z.object({
  ...envelope,                       // id, occurredAt: same for every event
  type: z.literal('credit.issued'),
  data: z.object({
    creditNumber: nonEmpty,          // becomes the ERP external ID: must be unique and stable
    invoiceNumber: nonEmpty,
    customer: z.object({ id: nonEmpty }),
    currency: currencyCode,
    amount: positiveMoney,
  }),
});
export type CreditIssuedEvent = z.infer<typeof CreditIssuedEvent>;
```

Then register it in the same file:

- add `CreditIssuedEvent` to the `LedgerEvent` discriminated union,
- add `'credit.issued': 'O2C'` to `EVENT_FLOW` (TypeScript fails until you do).

Add a case to `packages/shared/src/events.spec.ts`: one valid example and one that must be refused.

**Choose the external ID carefully.** The worker upserts by external ID, which is what makes retries and replays safe. Use the business number from the source (`creditNumber`), never something generated per attempt.

## 2. The mapper

`apps/integration-service/src/flows/o2c/credit.mapper.ts`: a pure function, event in, ERP request body out. No I/O, so it's easy to test.

```ts
export function mapCreditMemo(event: CreditIssuedEvent) {
  const { data } = event;
  return {
    tranId: data.creditNumber,
    entity: { externalId: data.customer.id },
    createdFrom: { externalId: data.invoiceNumber },
    currency: { id: currencyIdForCode(data.currency) },   // from src/lookups/lookups.ts
    total: data.amount,
  };
}
```

Rules that keep failures sorted correctly:

- **Bad data → `PermanentError`** with a clear code (`UNKNOWN_REASON_CODE`). It ends `FAILED` at once and isn't retried.
- **"Not yet" → `RetryableError`**, for example a credit note for an invoice that isn't in the ERP yet. That's what `PaymentReceivedHandler` does with `INVOICE_NOT_FOUND`.
- Lookups (currency, item, account IDs) live in `src/lookups/lookups.ts`. An unknown code should throw a `PermanentError` there, as the existing ones do.
- Money: round with `round2` from `flows/money.ts` when you add amounts up.

Test it in `credit.mapper.spec.ts`, next to the existing `bill.mapper.spec.ts`. Add an example event builder to `src/test-support/events.ts`.

## 3. The ERP record type

Only if the record type is new:

- `apps/integration-service/src/erp-client/erp-client.ts`: add `'creditMemo'` to `ErpRecordType`.
- `apps/mock-erp/src/records/record-types.ts`: add it to `RECORD_TYPES`, so the mock accepts it and SuiteQL can query it.
- `apps/integration-service/test/erp-contract.e2e-spec.ts`: the contract test catches a mismatch between what the client sends and what the mock accepts.

Against a real NetSuite, check the record's REST name and required fields in the account's REST API browser.

## 4. The handler

`apps/integration-service/src/flows/o2c/credit-issued.handler.ts`:

```ts
@Injectable()
export class CreditIssuedHandler implements FlowHandler<'credit.issued'> {
  readonly eventType = 'credit.issued' as const;

  constructor(private readonly erp: ErpClient) {}

  async handle(event: CreditIssuedEvent): Promise<FlowResult> {
    const memo = mapCreditMemo(event);            // map first: bad data fails before any write
    const { id } = await this.erp.upsert('creditMemo', event.data.creditNumber, memo);
    return { erpRecordType: 'creditMemo', erpRecordId: id };
  }
}
```

Register it: add `CreditIssuedHandler` to `HANDLERS` in `src/flows/flows.module.ts`. That's the only wiring. The registry refuses to start if two handlers claim the same event type.

Test it in `src/flows/flow-handlers.spec.ts` with a fake ERP client. Cover at least: the happy path, bad data writes nothing, and ERP errors pass through.

## 5. The secret

- **Existing source app:** nothing to do. The sender signs with the source's existing HMAC secret.
- **The handler needs a new credential** (another API, say): store it in Secrets Manager under `ledgerbridge/<name>` (extend `scripts/aws-secrets.ts` so it's created like the others), read it through `SecretsProvider`, and grant the worker read access with `secret.grantRead(worker)` in `infra/lib/ledgerbridge-stack.ts`. Never put the value in an environment variable or the template.

## 6. A new source app only

For example a `crm` app posting to `/webhooks/crm`. The API route `/webhooks/{source}` already accepts any name, so no infra change is needed for the URL.

1. `packages/shared/src/enums.ts`: add `'crm'` to `Source`.
2. `apps/integration-service/src/secrets/secrets-provider.ts`: add it to `WEBHOOK_SOURCES`.
3. `apps/integration-service/src/ingest/ingest.service.ts`: map the source to its flow.
4. Its HMAC secret:
   - locally: `WEBHOOK_SECRET_CRM` in `.env.example` and the mapping in `src/secrets/env-secrets.provider.ts`,
   - on AWS: add a `crm` key to the `ledgerbridge/webhooks` secret in `scripts/aws-secrets.ts`, then run `npm run aws:secrets`.
5. Give the sender its URL (`<ApiUrl>/webhooks/crm`) and secret over a secure channel. The signature format is in [apps/integration-service/README.md](../apps/integration-service/README.md#sending-a-webhook-by-hand).

## 7. Reconciliation (optional)

To have the nightly check compare this record type too, add it to `RECONCILED_TYPES` in `apps/integration-service/src/reconciliation/reconciliation-report.ts`. It works for any type the handler returns as `erpRecordType`.

## 8. Try it end to end

```bash
npm run lint && npm run typecheck && npm test && npm run test:e2e
```

Then add a scenario to `scripts/simulate.ts` (copy `happy`) that sends a few `credit.issued` events and reads them back from the mock ERP. Run it locally, then against AWS after deploying:

```bash
npm run simulate -- credits
npm run deploy
npm run simulate -- credits --aws
```

Finally, add a row for the new event to the README's flow table, and a line to [RUNBOOK.md](RUNBOOK.md) for any new error code operators might see.

## Checklist

- [ ] Schema + `LedgerEvent` + `EVENT_FLOW` + schema tests
- [ ] Mapper (pure) + mapper tests
- [ ] ERP record type in client and mock, if new
- [ ] Handler + added to `HANDLERS` + handler tests
- [ ] Secret, if a new credential or source app
- [ ] `RECONCILED_TYPES`, if it should be reconciled
- [ ] Simulator scenario, e2e tests green, deployed and verified with `--aws`
- [ ] README and RUNBOOK updated

# mock-erp

Stands in for NetSuite: same URL shapes, OAuth tokens, upsert by external ID, a small SuiteQL subset (SPEC §7). Data is kept in memory for now, so it resets on every restart.

## What's inside

| Folder | What it does |
|---|---|
| `src/auth/` | `POST /services/rest/auth/oauth2/v1/token` issues signed JWTs; a global guard requires `Authorization: Bearer <token>` on every other route |
| `src/records/` | The record API and its rules: upsert by external ID, references, invoice balances, payments. `RecordStore` is the storage interface (in memory now, DynamoDB in Phase 3) |
| `src/suiteql/` | The SuiteQL parser (`suiteql-parser.ts`, pure logic) and the query runner |
| `src/chaos/` | Failure injection: latency, random 503s, 429 rate limit |
| `src/common/` | NetSuite-style error format, applied to every error by one filter |
| `src/config/` | All settings, read from environment variables (see `.env.example` at the repo root) |

## Endpoints

| Method and path | What it does |
|---|---|
| `POST /services/rest/auth/oauth2/v1/token` | Get a token (`grant_type=client_credentials`, `client_id`, `client_secret`, form or JSON or HTTP Basic) |
| `POST /services/rest/record/v1/{type}` | Create. `204`, new record URL in `Location` |
| `GET /services/rest/record/v1/{type}/{id}` | Read by internal ID |
| `GET /services/rest/record/v1/{type}/eid:{externalId}` | Read by external ID |
| `PATCH /services/rest/record/v1/{type}/{id}` | Change only the fields sent |
| `PUT /services/rest/record/v1/{type}/eid:{externalId}` | **Upsert**: create if missing, update if present |
| `DELETE /services/rest/record/v1/{type}/{id}` | Delete |
| `POST /services/rest/query/v1/suiteql?limit=&offset=` | SuiteQL, needs header `Prefer: transient` |
| `GET` / `PUT /mock/chaos` | Read or change chaos settings (mock-only) |
| `GET /health` | Liveness, no token needed |

Record types: `customer`, `vendor`, `invoice`, `customerPayment`, `vendorBill`. The exact fields of each are in `src/records/record-types.ts`.

## Try it by hand

Start the server, then run these from Git Bash in another terminal:

```bash
npm run start:dev -w mock-erp
```

```bash
B=http://localhost:3001
R=$B/services/rest/record/v1

# 1. Get a token
TOKEN=$(curl -s -X POST $B/services/rest/auth/oauth2/v1/token \
  -d grant_type=client_credentials -d client_id=local-client -d client_secret=local-dev-secret-change-me \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
H="Authorization: Bearer $TOKEN"

# 2. Upsert the same customer twice -> still one record
curl -s -X PUT "$R/customer/eid:CUS-77" -H "$H" -H 'content-type: application/json' \
  -d '{"companyName":"Cedar Logistics SAL","email":"ap@cedar.example"}' -w '%{http_code}\n'
curl -s -X PUT "$R/customer/eid:CUS-77" -H "$H" -H 'content-type: application/json' \
  -d '{"companyName":"Cedar Logistics SAL","email":"ap@cedar.example"}' -w '%{http_code}\n'

# 3. SuiteQL
curl -s -X POST $B/services/rest/query/v1/suiteql -H "$H" -H 'Prefer: transient' \
  -H 'content-type: application/json' -d '{"q":"SELECT id, externalId, companyName FROM customer"}'

# 4. An invoice for that customer, then a payment that pays it in full
curl -s -X PUT "$R/invoice/eid:INV-1042" -H "$H" -H 'content-type: application/json' -d '{
  "entity": {"externalId": "CUS-77"}, "tranId": "INV-1042", "tranDate": "2026-11-11",
  "currency": {"id": "1"}, "item": {"items": [{"item": {"id": "501"}, "quantity": 3, "rate": 49}]}}'
curl -s -X PUT "$R/customerPayment/eid:PAY-5531" -H "$H" -H 'content-type: application/json' -d '{
  "customer": {"externalId": "CUS-77"}, "tranDate": "2026-11-20", "currency": {"id": "1"},
  "payment": 147, "apply": {"items": [{"doc": {"externalId": "INV-1042"}, "amount": 147}]}}'
curl -s "$R/invoice/eid:INV-1042" -H "$H"     # status: paidInFull

# 5. Turn on chaos: every ERP call now fails with 503
curl -s -X PUT $B/mock/chaos -H "$H" -H 'content-type: application/json' -d '{"errorRate": 1}'
```

## SuiteQL subset

```
SELECT <columns | *> FROM <customer|vendor|invoice|customerPayment|vendorBill>
[WHERE <field> <op> <literal> [AND ...]]      op: = != <> < <= > >=
[ORDER BY <field> [ASC|DESC]]
```

Anything else (`OR`, `JOIN`, functions, `;`) is a `400 INVALID_SUITEQL`. Result columns are lowercase, like real SuiteQL.

## How it differs from real NetSuite

- **Auth:** real NetSuite's client-credentials flow signs a JWT assertion with a certificate. The mock takes a plain client secret.
- **Fields:** a small, simplified subset. Item, account and currency IDs are accepted without checking.
- **SuiteQL:** real SuiteQL queries a `transaction` table filtered by type and supports full SQL; the mock has one table per record type and a tiny grammar.
- **Limits:** NetSuite limits *concurrent* requests per account; the mock limits requests per second.

## Commands

Run from the repo root (`-w mock-erp` targets this app) or from this folder.

| Command | What it does |
|---|---|
| `npm run start:dev -w mock-erp` | Local server with reload on http://localhost:3001 |
| `npm test -w mock-erp` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e -w mock-erp` | HTTP tests against the full app (`test/*.e2e-spec.ts`) |
| `npm run typecheck -w mock-erp` | TypeScript check, no output |
| `npm run build:lambda -w mock-erp` | Lambda bundle in `dist-lambda/` |

## How it runs on Lambda

- `src/app.factory.ts` builds the Nest app. Both `src/main.ts` (local server) and `src/lambda/http.ts` (Lambda) use it, so they behave the same.
- `src/lambda/http.ts` wraps the app with `@codegenie/serverless-express` and caches it between invocations (cold start once, then warm).
- `npm run build:lambda` bundles with **rspack**, not webpack: Nest 12's webpack builder refuses ESM projects. rspack keeps the decorator metadata that dependency injection needs. Settings and reasons are in `rspack.config.cjs`.
- Output: `dist-lambda/http.js`, one file with every dependency inside, plus a `package.json` marking it CommonJS. Lambda handler: `http.handler`.

Try the bundle locally without AWS (from the repo root, Git Bash):

```bash
npm run build:lambda
MSYS_NO_PATHCONV=1 npm run invoke:lambda -- apps/mock-erp/dist-lambda/http.js GET /health
```

`MSYS_NO_PATHCONV=1` stops Git Bash from rewriting `/health` into a Windows path. It isn't needed in PowerShell.

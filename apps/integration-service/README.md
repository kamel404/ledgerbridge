# integration-service

The product: webhook ingest, mapping, ERP client, worker, sync log, admin API (SPEC §8).

## Commands

Run from the repo root (`-w integration-service` targets this app) or from this folder.

| Command | What it does |
|---|---|
| `npm run start:dev -w integration-service` | Local server with reload on http://localhost:3000 |
| `npm test -w integration-service` | Unit tests (`src/**/*.spec.ts`) |
| `npm run test:e2e -w integration-service` | HTTP tests against the full app (`test/*.e2e-spec.ts`) |
| `npm run typecheck -w integration-service` | TypeScript check, no output |
| `npm run build:lambda -w integration-service` | Lambda bundle in `dist-lambda/` |

## How it runs on Lambda

- `src/app.factory.ts` builds the Nest app. Both `src/main.ts` (local server) and `src/lambda/http.ts` (Lambda) use it, so they behave the same.
- `src/lambda/http.ts` wraps the app with `@codegenie/serverless-express` and caches it between invocations (cold start once, then warm).
- `npm run build:lambda` bundles with **rspack**, not webpack: Nest 12's webpack builder refuses ESM projects. rspack keeps the decorator metadata that dependency injection needs. Settings and reasons are in `rspack.config.cjs`.
- Output: `dist-lambda/http.js`, one file with every dependency inside, plus a `package.json` marking it CommonJS. Lambda handler: `http.handler`.

Try the bundle locally without AWS (from the repo root, Git Bash):

```bash
npm run build:lambda
MSYS_NO_PATHCONV=1 npm run invoke:lambda -- apps/integration-service/dist-lambda/http.js GET /health
```

`MSYS_NO_PATHCONV=1` stops Git Bash from rewriting `/health` into a Windows path. It isn't needed in PowerShell.

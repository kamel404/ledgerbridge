# dashboard

The operator dashboard (SPEC §9): Next.js App Router. It runs on your machine, or live on AWS as a Lambda Web Function, against the admin API.

| Page | What it shows |
|---|---|
| **Overview** (`/`) | Events by status for the last 24 hours (click a tile to see them), queue depths, a table per flow. Refreshes every 15 s |
| **Syncs** (`/syncs`) | Every event, newest change first. Filter by status and flow, search by business key (`INV-1042`) or event ID, next page / first page |
| **Sync detail** (`/syncs/<eventId>`) | Error, details, ERP record, timeline of every status change, the payload, and **Replay** for `FAILED` and `DEAD` |

## Run it

From the repo root:

```bash
npm run dashboard:env           # writes apps/dashboard/.env.local for the deployed API
npm run dashboard               # http://localhost:3002
```

Against a local integration service instead: `npm run dashboard:env -- --local` (needs `ADMIN_API_KEY` in the root `.env`).

## Live on AWS

`npm run deploy` (repo root) also deploys the dashboard as a **Lambda Web Function** in `LedgerBridgeStack`:

1. `npm run build:lambda -w dashboard` runs `next build` (`output: 'standalone'`), then `scripts/package-web.mjs` packs `.next/standalone` + static files into `dist-web/`.
2. CDK uploads `dist-web/` and creates the Web Function with a public HTTPS endpoint, printed as **`WebDashboardUrl`** in `infra/cdk-outputs.json`.
3. At runtime it reads the admin key (`ledgerbridge/admin`) and the login secret (`ledgerbridge/dashboard`) from Secrets Manager. Neither value is in the template or the environment.

**Login:** every page needs the password `DASHBOARD_PASSWORD` from the root `.env.aws` (made by `npm run aws:secrets`). A successful login sets a signed, HttpOnly, Secure cookie valid for 12 hours. To change the password, edit `DASHBOARD_PASSWORD` in `.env.aws` and re-run `npm run aws:secrets`; to log every session out, change `DASHBOARD_SESSION_KEY` the same way. New values apply within 5 minutes (secrets are cached that long).

| File | Role |
|---|---|
| `proxy.ts` | Sends anyone without a valid session cookie to `/login` |
| `lib/session.ts` | Signs and checks the cookie (HMAC-SHA256), compares passwords in constant time |
| `lib/settings.ts` | Reads secrets from Secrets Manager (AWS) or `.env.local` (your machine); login fails closed if no password is set |
| `app/login/` | The login page and the log-in / log-out actions |

Locally, `npm run dashboard:env` writes `DASHBOARD_AUTH=off`, so there's no login page on `127.0.0.1`. Env files are never put in the AWS package.

## How the admin key stays secret

- `ADMIN_API_URL` and `ADMIN_API_KEY` live in `.env.local` (git-ignored) without a `NEXT_PUBLIC_` prefix, so Next.js never puts them in browser code.
- Every admin API call is in `lib/admin-api.ts`, which starts with `import 'server-only'`: the build fails if a browser component ever imports it.
- Pages are server components; Replay is a server action. The browser only receives HTML (and the action's result message).
- `AutoRefresh` uses `router.refresh()`, which re-renders on the server; the browser still never calls the admin API.
- The dev and start servers listen on `127.0.0.1` only. Locally the login is off (whoever can open it can Replay), so it must not be reachable from the rest of your network. Next.js listens on every network address by default.
- On AWS the endpoint is public, so the password login above is always on, and the Replay action checks the session again itself.

## Commands

| Command | What it does |
|---|---|
| `npm run dev -w dashboard` | Dev server on port 3002 |
| `npm run build -w dashboard` | Production build |
| `npm test -w dashboard` | Unit tests (`lib/`) |
| `npm run typecheck -w dashboard` / `npm run lint -w dashboard` | Checks |

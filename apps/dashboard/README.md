# dashboard

The operator dashboard (SPEC §9): Next.js App Router, running on your machine against the admin API.

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

## How the admin key stays secret

- `ADMIN_API_URL` and `ADMIN_API_KEY` live in `.env.local` (git-ignored) without a `NEXT_PUBLIC_` prefix, so Next.js never puts them in browser code.
- Every admin API call is in `lib/admin-api.ts`, which starts with `import 'server-only'`: the build fails if a browser component ever imports it.
- Pages are server components; Replay is a server action. The browser only receives HTML (and the action's result message).
- `AutoRefresh` uses `router.refresh()`, which re-renders on the server; the browser still never calls the admin API.
- The dev and start servers listen on `127.0.0.1` only. The dashboard has no login of its own (whoever can open it can Replay), so it must not be reachable from the rest of your network. Next.js listens on every network address by default.

## Commands

| Command | What it does |
|---|---|
| `npm run dev -w dashboard` | Dev server on port 3002 |
| `npm run build -w dashboard` | Production build |
| `npm test -w dashboard` | Unit tests (`lib/`) |
| `npm run typecheck -w dashboard` / `npm run lint -w dashboard` | Checks |

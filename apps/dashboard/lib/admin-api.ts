import 'server-only';
import { loadSettings } from './settings';
import type { Stats, SyncFilters, SyncPage, SyncRecord } from './types';

// The admin API client. `server-only` makes the build fail if this file is
// ever imported by code that runs in the browser: the API key must stay on
// the Next.js server (SPEC §8.6, §9). Pages call it from server components
// and server actions; the browser only ever receives rendered HTML.

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

interface AdminConfig {
  baseUrl: string;
  apiKey: string;
}

/** URL from ADMIN_API_URL; key from ADMIN_API_KEY locally, or Secrets Manager on AWS (lib/settings.ts). */
async function config(): Promise<AdminConfig> {
  const { adminApiUrl: baseUrl, adminApiKey: apiKey } = await loadSettings();
  if (!baseUrl || !apiKey) {
    throw new AdminApiError(
      500,
      'ADMIN_API_URL and ADMIN_API_KEY are not set. Create apps/dashboard/.env.local (run `npm run dashboard:env` from the repo root) and restart the dashboard.',
    );
  }
  return { baseUrl, apiKey };
}

async function call<T>(method: 'GET' | 'POST', path: string, fetchFn: typeof fetch = fetch): Promise<T> {
  const { baseUrl, apiKey } = await config();
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      cache: 'no-store', // always live data
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new AdminApiError(502, `Admin API unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = (body as { message?: unknown } | undefined)?.message;
    throw new AdminApiError(res.status, typeof message === 'string' ? message : `Admin API answered ${res.status}`);
  }
  return body as T;
}

/** Query string for the Syncs list; empty filters are left out. */
export function syncsQuery(filters: SyncFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const adminApi = {
  stats: (fetchFn?: typeof fetch) => call<Stats>('GET', '/admin/stats', fetchFn),
  listSyncs: (filters: SyncFilters, fetchFn?: typeof fetch) => call<SyncPage>('GET', `/admin/syncs${syncsQuery(filters)}`, fetchFn),
  getSync: (eventId: string, fetchFn?: typeof fetch) =>
    call<SyncRecord>('GET', `/admin/syncs/${encodeURIComponent(eventId)}`, fetchFn),
  replay: (eventId: string, fetchFn?: typeof fetch) =>
    call<{ syncId: string; status: string }>('POST', `/admin/syncs/${encodeURIComponent(eventId)}/replay`, fetchFn),
};

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// Where the dashboard gets its secrets. Two sources:
//
// - On AWS (the Web Function): ADMIN_SECRET_NAME / DASHBOARD_SECRET_NAME name
//   Secrets Manager secrets, read at runtime with the function's IAM role. The
//   values are never in the CloudFormation template or the environment.
// - On your machine: ADMIN_API_KEY, DASHBOARD_PASSWORD, DASHBOARD_SESSION_KEY in
//   .env.local (written by `npm run dashboard:env`).
//
// Login fails closed: with no password configured every page is blocked, unless
// DASHBOARD_AUTH=off says so explicitly (`dashboard:env -- --local` writes it,
// for the dev server bound to 127.0.0.1).
//
// No `import 'server-only'` here because proxy.ts imports it too. It is only
// imported by server code (proxy, server actions, admin-api.ts, which is server-only).

export type AuthSettings =
  | { mode: 'off' }
  | { mode: 'password'; password: string; sessionKey: string }
  | { mode: 'unconfigured' };

export interface Settings {
  adminApiUrl?: string;
  adminApiKey?: string;
  auth: AuthSettings;
}

/** Re-read secrets after this long, so a rotated secret is picked up without a redeploy. */
const CACHE_MS = 5 * 60_000;

let cached: { at: number; value: Promise<Settings> } | undefined;
let client: SecretsManagerClient | undefined;

async function readJsonSecret(name: string): Promise<Record<string, unknown>> {
  client ??= new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(res.SecretString ?? '{}') as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

async function load(env: NodeJS.ProcessEnv): Promise<Settings> {
  const adminApiUrl = env.ADMIN_API_URL?.replace(/\/+$/, '') || undefined;

  let adminApiKey = str(env.ADMIN_API_KEY);
  if (!adminApiKey && env.ADMIN_SECRET_NAME) adminApiKey = str((await readJsonSecret(env.ADMIN_SECRET_NAME)).apiKey);

  let password = str(env.DASHBOARD_PASSWORD);
  let sessionKey = str(env.DASHBOARD_SESSION_KEY);
  if ((!password || !sessionKey) && env.DASHBOARD_SECRET_NAME) {
    const s = await readJsonSecret(env.DASHBOARD_SECRET_NAME);
    password = str(s.password);
    sessionKey = str(s.sessionKey);
  }

  let auth: AuthSettings;
  if (password && sessionKey) auth = { mode: 'password', password, sessionKey };
  else if (env.DASHBOARD_AUTH === 'off') auth = { mode: 'off' };
  else auth = { mode: 'unconfigured' };

  return { adminApiUrl, adminApiKey, auth };
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<Settings> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = load(env);
  cached = { at: now, value };
  // Don't keep a failure (e.g. Secrets Manager briefly unreachable) for 5 minutes.
  value.catch(() => {
    if (cached?.value === value) cached = undefined;
  });
  return value;
}

/** Tests only. */
export function resetSettingsCache(): void {
  cached = undefined;
}

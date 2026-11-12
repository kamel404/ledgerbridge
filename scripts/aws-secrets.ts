// Creates the cloud secrets LedgerBridge needs on AWS. Run once before the first deploy:
//
//   npm run aws:secrets             create missing values, store the secrets in Secrets Manager
//   npm run aws:secrets -- --delete delete the Secrets Manager secrets (cleanup after `cdk destroy`)
//
// What it does:
// 1. Creates `.env.aws` in the repo root (gitignored) with strong random values,
//    keeping any values already there. The simulator signs webhooks with these,
//    and CDK reads the mock ERP's values from it.
// 2. Stores two JSON secrets in Secrets Manager (creates them, or updates
//    them if they exist):
//    - `ledgerbridge/webhooks` {"billing", "procurement"}: read by the ingest Lambda
//    - `ledgerbridge/erp` {"clientId", "clientSecret"}: read by the worker Lambda
//      to log in to the ERP. Same values the mock ERP is deployed with.
//    - `ledgerbridge/admin` {"apiKey"}: checked by the admin Lambda; the dashboard
//      sends it (`npm run dashboard:env` copies it into apps/dashboard/.env.local)
//
// Secret values are never printed. They go to the AWS CLI through a temporary
// file (not the command line) that is deleted right after.
//
// Uses the AWS CLI with profile `ledgerbridge` (override: AWS_PROFILE=...), see aws-cli.ts.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws, loginHint } from './aws-cli.ts';

const ENV_FILE = fileURLToPath(new URL('../.env.aws', import.meta.url));
const WEBHOOK_SECRET_NAME = 'ledgerbridge/webhooks';
const ERP_SECRET_NAME = 'ledgerbridge/erp';
const ADMIN_SECRET_NAME = 'ledgerbridge/admin';

const random = () => randomBytes(32).toString('base64url');

/** Reads KEY=value lines. */
function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) values.set(m[1]!, m[2]!);
  }
  return values;
}

function ensureEnvFile(): Map<string, string> {
  const values = readEnvFile(ENV_FILE);
  const defaults: Record<string, () => string> = {
    MOCK_ERP_CLIENT_ID: () => 'ledgerbridge',
    MOCK_ERP_CLIENT_SECRET: random,
    MOCK_ERP_JWT_SECRET: random,
    WEBHOOK_SECRET_NAME: () => WEBHOOK_SECRET_NAME,
    WEBHOOK_SECRET_BILLING: random,
    WEBHOOK_SECRET_PROCUREMENT: random,
    ERP_SECRET_NAME: () => ERP_SECRET_NAME,
    ADMIN_SECRET_NAME: () => ADMIN_SECRET_NAME,
    ADMIN_API_KEY: random,
  };
  const added: string[] = [];
  for (const [key, make] of Object.entries(defaults)) {
    if (!values.get(key)) {
      values.set(key, make());
      added.push(key);
    }
  }
  const body = [
    '# Cloud-only values for the AWS deployment. Made by `npm run aws:secrets`.',
    '# Gitignored: never commit this file. Delete it and re-run the script to rotate everything.',
    ...[...values].map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, body, { mode: 0o600 });
  console.log(added.length ? `.env.aws: created ${added.join(', ')}` : '.env.aws: all values already present');
  return values;
}

function secretExists(name: string): boolean {
  try {
    aws(['secretsmanager', 'describe-secret', '--secret-id', name]);
    return true;
  } catch (err) {
    if (String((err as { stderr?: string }).stderr).includes('ResourceNotFoundException')) return false;
    throw err;
  }
}

/** Passes the value through a temp file so it never appears in a process list. */
function withSecretFile<T>(value: string, fn: (fileArg: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-secret-'));
  const file = path.join(dir, 'value.json');
  try {
    writeFileSync(file, value, { mode: 0o600 });
    return fn(`file://${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Creates the secret, or stores a new value if it already exists. */
function storeSecret(name: string, description: string, value: Record<string, string | undefined>): void {
  const json = JSON.stringify(value);
  if (secretExists(name)) {
    withSecretFile(json, (f) => aws(['secretsmanager', 'put-secret-value', '--secret-id', name, '--secret-string', f]));
    console.log(`Secrets Manager: updated ${name}`);
  } else {
    withSecretFile(json, (f) =>
      aws([
        'secretsmanager', 'create-secret',
        '--name', name,
        '--description', description,
        '--tags', 'Key=project,Value=ledgerbridge',
        '--secret-string', f,
      ]),
    );
    console.log(`Secrets Manager: created ${name}`);
  }
}

function storeAll(values: Map<string, string>): void {
  storeSecret(values.get('WEBHOOK_SECRET_NAME')!, 'LedgerBridge webhook HMAC secrets, one per source app', {
    billing: values.get('WEBHOOK_SECRET_BILLING'),
    procurement: values.get('WEBHOOK_SECRET_PROCUREMENT'),
  });
  storeSecret(values.get('ERP_SECRET_NAME')!, 'LedgerBridge OAuth client credentials for the ERP', {
    clientId: values.get('MOCK_ERP_CLIENT_ID'),
    clientSecret: values.get('MOCK_ERP_CLIENT_SECRET'),
  });
  storeSecret(values.get('ADMIN_SECRET_NAME')!, 'LedgerBridge admin API key (dashboard)', {
    apiKey: values.get('ADMIN_API_KEY'),
  });
}

function deleteAll(): void {
  const values = readEnvFile(ENV_FILE);
  const names = [
    values.get('WEBHOOK_SECRET_NAME') ?? WEBHOOK_SECRET_NAME,
    values.get('ERP_SECRET_NAME') ?? ERP_SECRET_NAME,
    values.get('ADMIN_SECRET_NAME') ?? ADMIN_SECRET_NAME,
  ];
  for (const name of names) {
    if (!secretExists(name)) {
      console.log(`Secrets Manager: ${name} does not exist`);
      continue;
    }
    // No recovery window: deleted at once, so the name can be reused and billing stops.
    aws(['secretsmanager', 'delete-secret', '--secret-id', name, '--force-delete-without-recovery']);
    console.log(`Secrets Manager: deleted ${name}`);
  }
}

try {
  if (process.argv.includes('--delete')) deleteAll();
  else storeAll(ensureEnvFile());
} catch (err) {
  const e = err as { stderr?: string; message?: string };
  console.error(e.stderr?.trim() || e.message || String(err));
  const hint = loginHint(err);
  if (hint) console.error(hint);
  process.exit(1);
}

// Creates the cloud secrets LedgerBridge needs on AWS. Run once before the first deploy:
//
//   npm run aws:secrets             create missing values, store the webhook secret in Secrets Manager
//   npm run aws:secrets -- --delete delete the Secrets Manager secret (cleanup after `cdk destroy`)
//
// What it does:
// 1. Creates `.env.aws` in the repo root (gitignored) with strong random values,
//    keeping any values already there. The simulator signs webhooks with these,
//    and CDK reads the mock ERP's values from it.
// 2. Stores {"billing": ..., "procurement": ...} in Secrets Manager as
//    `ledgerbridge/webhooks` (creates it, or updates it if it exists).
//    The ingest Lambda reads it from there at runtime.
//
// Secret values are never printed. They go to the AWS CLI through a temporary
// file (not the command line) that is deleted right after.
//
// Uses the AWS CLI with profile `ledgerbridge` (override: AWS_PROFILE=...).

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGION = 'eu-north-1';
const PROFILE = process.env.AWS_PROFILE ?? 'ledgerbridge';
const ENV_FILE = fileURLToPath(new URL('../.env.aws', import.meta.url));
const WEBHOOK_SECRET_NAME = 'ledgerbridge/webhooks';

/** The AWS CLI: on PATH, or where its Windows installer puts it. */
function awsCli(): string {
  const candidates = ['aws'];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Amazon', 'AWSCLIV2', 'aws.exe'));
  }
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      // try the next one
    }
  }
  throw new Error('AWS CLI not found. Install it (see docs/PLAN.md Part A.5).');
}

function aws(args: string[]): string {
  return execFileSync(awsCli(), [...args, '--region', REGION, '--profile', PROFILE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUTF8: '1' },
  });
}

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

function storeWebhookSecret(values: Map<string, string>): void {
  const name = values.get('WEBHOOK_SECRET_NAME')!;
  const value = JSON.stringify({
    billing: values.get('WEBHOOK_SECRET_BILLING'),
    procurement: values.get('WEBHOOK_SECRET_PROCUREMENT'),
  });
  if (secretExists(name)) {
    withSecretFile(value, (f) => aws(['secretsmanager', 'put-secret-value', '--secret-id', name, '--secret-string', f]));
    console.log(`Secrets Manager: updated ${name}`);
  } else {
    withSecretFile(value, (f) =>
      aws([
        'secretsmanager', 'create-secret',
        '--name', name,
        '--description', 'LedgerBridge webhook HMAC secrets, one per source app',
        '--tags', 'Key=project,Value=ledgerbridge',
        '--secret-string', f,
      ]),
    );
    console.log(`Secrets Manager: created ${name}`);
  }
}

function deleteWebhookSecret(): void {
  const name = readEnvFile(ENV_FILE).get('WEBHOOK_SECRET_NAME') ?? WEBHOOK_SECRET_NAME;
  if (!secretExists(name)) {
    console.log(`Secrets Manager: ${name} does not exist`);
    return;
  }
  // No recovery window: deleted at once, so the name can be reused and billing stops.
  aws(['secretsmanager', 'delete-secret', '--secret-id', name, '--force-delete-without-recovery']);
  console.log(`Secrets Manager: deleted ${name}`);
}

try {
  if (process.argv.includes('--delete')) deleteWebhookSecret();
  else storeWebhookSecret(ensureEnvFile());
} catch (err) {
  const e = err as { stderr?: string; message?: string };
  console.error(e.stderr?.trim() || e.message || String(err));
  if (String(e.stderr).match(/ExpiredToken|Unable to locate credentials|login/i)) {
    console.error(`Your AWS login may have expired. Run: aws login --profile ${PROFILE}`);
  }
  process.exit(1);
}

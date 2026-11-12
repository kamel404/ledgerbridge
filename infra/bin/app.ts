// CDK app: `npm run deploy` (repo root) builds the Lambda bundles, then runs this.
import { existsSync } from 'node:fs';
import path from 'node:path';
import cdk from 'aws-cdk-lib';
import { LedgerBridgeStack } from '../lib/ledgerbridge-stack.ts';
import { MockErpStack } from '../lib/mock-erp-stack.ts';
import { REPO_ROOT } from '../lib/shared.ts';

/**
 * Our AWS project only allows resources in its selected Region (new AWS
 * experience), so the Region is fixed here rather than taken from the CLI.
 */
const REGION = 'eu-north-1';

// Cloud-only values made by `npm run aws:secrets` (gitignored, never committed).
const envFile = path.join(REPO_ROOT, '.env.aws');
if (existsSync(envFile)) process.loadEnvFile(envFile);
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run \`npm run aws:secrets\` first (it creates .env.aws).`);
  return value;
}

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };

new MockErpStack(app, 'MockErpStack', {
  env,
  description: 'LedgerBridge: mock ERP (fake NetSuite)',
  clientId: required('MOCK_ERP_CLIENT_ID'),
  clientSecret: required('MOCK_ERP_CLIENT_SECRET'),
  jwtSecret: required('MOCK_ERP_JWT_SECRET'),
});

new LedgerBridgeStack(app, 'LedgerBridgeStack', {
  env,
  description: 'LedgerBridge: webhook ingest, sync log, queue',
  webhookSecretName: required('WEBHOOK_SECRET_NAME'),
});

// Tags show up in the Billing console, so you can see what this project costs.
cdk.Tags.of(app).add('project', 'ledgerbridge');

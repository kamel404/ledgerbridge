// Turns chaos on the deployed mock ERP on or off, to test retries and alarms:
//
//   npm run chaos -- 1      every ERP request answers 503 (the ERP is "down")
//   npm run chaos -- 0.3    30% of requests fail
//   npm run chaos -- 0      back to normal (a normal `npm run deploy` also resets it)
//
// It redeploys only MockErpStack with a different CHAOS_ERROR_RATE environment
// variable (about a minute). Why not the mock's PUT /mock/chaos endpoint: on
// Lambda it only changes the one copy of the mock that answers that request,
// while other copies keep working normally.
//
// Needs the Lambda bundles from a previous `npm run deploy` (or `npm run build:lambda`).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROFILE } from './aws-cli.ts';

const arg = process.argv[2] ?? '';
const rate = ({ on: 1, off: 0 } as Record<string, number>)[arg] ?? Number(arg);
if (arg === '' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
  console.error('Usage: npm run chaos -- <rate between 0 and 1 | on | off>');
  process.exit(2);
}

for (const app of ['mock-erp', 'integration-service']) {
  if (!existsSync(fileURLToPath(new URL(`../apps/${app}/dist-lambda`, import.meta.url)))) {
    console.error(`apps/${app}/dist-lambda is missing. Run \`npm run build:lambda\` first.`);
    process.exit(2);
  }
}

console.log(rate > 0 ? `Mock ERP: ${rate * 100}% of requests will fail with 503` : 'Mock ERP: chaos off');
const result = spawnSync(
  'npm',
  ['run', 'cdk', '-w', 'infra', '--', 'deploy', 'MockErpStack', '--profile', PROFILE, '-c', `chaosErrorRate=${rate}`],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(result.status ?? 1);

// Writes apps/dashboard/.env.local so the dashboard can call the admin API:
//
//   npm run dashboard:env            the deployed API (URL from infra/cdk-outputs.json,
//                                    key from .env.aws, both made by deploy / aws:secrets)
//   npm run dashboard:env -- --local the local integration service (http://localhost:3000,
//                                    key ADMIN_API_KEY from the root .env)
//
// The file is git-ignored and only read by the Next.js server. The key is never printed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const local = process.argv.includes('--local');

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  );
}

let url: string | undefined;
let key: string | undefined;
if (local) {
  const env = readEnv(repoFile('.env'));
  url = `http://localhost:${env.INTEGRATION_SERVICE_PORT ?? 3000}`;
  key = env.ADMIN_API_KEY;
  if (!key) {
    console.error('ADMIN_API_KEY is missing from the root .env (see .env.example).');
    process.exit(2);
  }
} else {
  const outputsFile = repoFile('infra/cdk-outputs.json');
  if (!existsSync(outputsFile)) {
    console.error('infra/cdk-outputs.json is missing. Run `npm run deploy` first.');
    process.exit(2);
  }
  const outputs = JSON.parse(readFileSync(outputsFile, 'utf8')) as Record<string, Record<string, string>>;
  url = outputs.LedgerBridgeStack?.ApiUrl;
  key = readEnv(repoFile('.env.aws')).ADMIN_API_KEY;
  if (!url || !key) {
    console.error('Need ApiUrl in infra/cdk-outputs.json and ADMIN_API_KEY in .env.aws: run `npm run aws:secrets` and `npm run deploy`.');
    process.exit(2);
  }
}

const target = repoFile('apps/dashboard/.env.local');
writeFileSync(
  target,
  [
    '# Made by `npm run dashboard:env`. Git-ignored; read only by the Next.js server.',
    `ADMIN_API_URL=${url}`,
    `ADMIN_API_KEY=${key}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`apps/dashboard/.env.local written: admin API at ${url}. Restart the dashboard if it is running.`);

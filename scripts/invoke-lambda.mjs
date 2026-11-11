// Calls a bundled Lambda handler locally, the way AWS would, with a fake
// API Gateway (HTTP API, payload v2.0) event. No AWS account needed.
//
// Usage:
//   node scripts/invoke-lambda.mjs <bundle.js> [METHOD] [path] [jsonBody]
// Example:
//   node scripts/invoke-lambda.mjs apps/mock-erp/dist-lambda/http.js GET /health

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [bundle, method = 'GET', path = '/health', body] = process.argv.slice(2);
if (!bundle) {
  console.error('Usage: node scripts/invoke-lambda.mjs <bundle.js> [METHOD] [path] [jsonBody]');
  process.exit(2);
}

// Lambda loads CommonJS handlers with require(), so we do too.
const require = createRequire(import.meta.url);
const { handler } = require(resolve(bundle));

const [rawPath, rawQueryString = ''] = path.split('?');
const event = {
  version: '2.0',
  routeKey: '$default',
  rawPath,
  rawQueryString,
  headers: { host: 'localhost', 'content-type': 'application/json' },
  requestContext: {
    accountId: '000000000000',
    apiId: 'local',
    domainName: 'localhost',
    http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'invoke-lambda' },
    requestId: `local-${Date.now()}`,
    routeKey: '$default',
    stage: '$default',
    time: new Date().toUTCString(),
    timeEpoch: Date.now(),
  },
  body,
  isBase64Encoded: false,
};

const context = {
  functionName: 'local',
  awsRequestId: event.requestContext.requestId,
  getRemainingTimeInMillis: () => 30_000,
};

// Call twice: the first is a "cold start" (app bootstraps), the second reuses
// the cached app, as a warm Lambda would.
for (const label of ['cold', 'warm']) {
  const started = performance.now();
  const result = await handler(event, context);
  const ms = Math.round(performance.now() - started);
  console.log(`[${label}] ${ms} ms ->`, JSON.stringify(result));
}

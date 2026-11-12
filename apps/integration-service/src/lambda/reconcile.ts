import { NestFactory } from '@nestjs/core';
import type { Handler } from 'aws-lambda';
import { addLambdaContext, nestLoggerOptions } from '../observability/json-logger.js';
import { Reconciler } from '../reconciliation/reconciler.js';
import type { ReconciliationReport } from '../reconciliation/reconciliation-report.js';
import { ReconcileAppModule } from '../reconciliation/reconciliation.module.js';

// Lambda entry point for reconciliation. EventBridge Scheduler calls it at
// 02:00 UTC; `npm run reconcile` calls it by hand. Input: {} normally, or
// {"includeRecent": true} to also check the last 5 minutes (for testing).
// Returns the report, so a manual call shows the result straight away.
let cached: Promise<Reconciler> | undefined;

async function bootstrap(): Promise<Reconciler> {
  const app = await NestFactory.createApplicationContext(ReconcileAppModule, nestLoggerOptions());
  return app.get(Reconciler);
}

export const handler: Handler<{ includeRecent?: boolean } | null, ReconciliationReport> = async (event, context) => {
  addLambdaContext(context);
  cached ??= bootstrap().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return (await cached).run(new Date(), event?.includeRecent === true ? { settleMs: 0 } : {});
};

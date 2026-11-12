import { NestFactory } from '@nestjs/core';
import { addLambdaContext, nestLoggerOptions } from '../observability/json-logger.js';
import type { Handler, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { DeadLetterHandler, DlqAppModule } from '../dlq/dead-letter.handler.js';
import { SYNC_METRICS, type SyncMetrics } from '../observability/sync-metrics.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';

// Lambda entry point for the dead-letter queue: marks each dead event DEAD.
let cached: Promise<DeadLetterHandler> | undefined;

async function bootstrap(): Promise<DeadLetterHandler> {
  const app = await NestFactory.createApplicationContext(DlqAppModule, nestLoggerOptions());
  return new DeadLetterHandler(app.get(SyncLogService), app.get<SyncMetrics>(SYNC_METRICS));
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (event, context) => {
  addLambdaContext(context);
  cached ??= bootstrap().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return (await cached).handle(event.Records);
};

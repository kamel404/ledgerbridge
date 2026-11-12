import { NestFactory } from '@nestjs/core';
import type { Handler, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { DeadLetterHandler, DlqAppModule } from '../dlq/dead-letter.handler.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';

// Lambda entry point for the dead-letter queue: marks each dead event DEAD.
let cached: Promise<DeadLetterHandler> | undefined;

async function bootstrap(): Promise<DeadLetterHandler> {
  const app = await NestFactory.createApplicationContext(DlqAppModule);
  return new DeadLetterHandler(app.get(SyncLogService));
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (event) => {
  cached ??= bootstrap().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return (await cached).handle(event.Records);
};

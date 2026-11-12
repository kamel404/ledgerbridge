import { SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import type { Handler, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { SqsBatchHandler, sqsChangeVisibility } from '../worker/sqs-batch-handler.js';
import { SyncWorker } from '../worker/sync-worker.js';
import { WorkerAppModule } from '../worker/worker-app.module.js';

// Lambda entry point for the worker, triggered by the SyncQueue (batches of up to 5).
// Nest runs as an application context: dependency injection, no HTTP server.
// Built once per container (cold start) and reused while warm.
let cached: Promise<SqsBatchHandler> | undefined;

async function bootstrap(): Promise<SqsBatchHandler> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  return new SqsBatchHandler(app.get(SyncWorker), sqsChangeVisibility(new SQSClient({})));
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (event) => {
  cached ??= bootstrap().catch((err: unknown) => {
    cached = undefined; // try again on the next invocation instead of caching the failure
    throw err;
  });
  return (await cached).handle(event.Records);
};

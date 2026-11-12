import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { EVENT_DISPATCHER, InlineDispatcher, type EventDispatcher } from '../ingest/event-dispatcher.js';
import { SqsDispatcher } from '../ingest/sqs-dispatcher.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { SyncWorker } from '../worker/sync-worker.js';
import { WorkerModule } from '../worker/worker.module.js';
import { EventIntakeService } from './event-intake.service.js';

/** SQS when a queue is configured (on AWS), inline processing otherwise (local). */
function createDispatcher(config: IntegrationConfig, worker: SyncWorker): EventDispatcher {
  return config.syncQueueUrl
    ? new SqsDispatcher(new SQSClient({}), config.syncQueueUrl)
    : new InlineDispatcher(worker);
}

/** Dedup + RECEIVED + dispatch, shared by the webhook ingest and the CSV import. */
@Module({
  imports: [SyncLogModule, WorkerModule],
  providers: [
    EventIntakeService,
    { provide: EVENT_DISPATCHER, useFactory: createDispatcher, inject: [INTEGRATION_CONFIG, SyncWorker] },
  ],
  exports: [EventIntakeService, EVENT_DISPATCHER],
})
export class IntakeModule {}

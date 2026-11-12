import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { SyncWorker } from '../worker/sync-worker.js';
import { WorkerModule } from '../worker/worker.module.js';
import { EVENT_DISPATCHER, InlineDispatcher, type EventDispatcher } from './event-dispatcher.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { SqsDispatcher } from './sqs-dispatcher.js';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

/** SQS when a queue is configured (on AWS), inline processing otherwise (local). */
function createDispatcher(config: IntegrationConfig, worker: SyncWorker): EventDispatcher {
  return config.syncQueueUrl
    ? new SqsDispatcher(new SQSClient({}), config.syncQueueUrl)
    : new InlineDispatcher(worker);
}

@Module({
  imports: [SyncLogModule, WorkerModule],
  controllers: [IngestController],
  providers: [
    IngestService,
    WebhookSignatureGuard,
    { provide: EVENT_DISPATCHER, useFactory: createDispatcher, inject: [INTEGRATION_CONFIG, SyncWorker] },
  ],
})
export class IngestModule {}

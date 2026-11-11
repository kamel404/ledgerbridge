import { Module } from '@nestjs/common';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { WorkerModule } from '../worker/worker.module.js';
import { EVENT_DISPATCHER, InlineDispatcher } from './event-dispatcher.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

@Module({
  imports: [SyncLogModule, WorkerModule],
  controllers: [IngestController],
  providers: [IngestService, WebhookSignatureGuard, { provide: EVENT_DISPATCHER, useClass: InlineDispatcher }],
})
export class IngestModule {}

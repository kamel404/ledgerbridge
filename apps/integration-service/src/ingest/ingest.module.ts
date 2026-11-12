import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { IngestController } from './ingest.controller.js';
import { IngestService } from './ingest.service.js';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

@Module({
  imports: [SyncLogModule, IntakeModule],
  controllers: [IngestController],
  providers: [IngestService, WebhookSignatureGuard],
})
export class IngestModule {}

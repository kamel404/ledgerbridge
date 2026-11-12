import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { IntakeModule } from '../intake/intake.module.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { NoQueueStats, QUEUE_STATS, SqsQueueStats, type QueueStatsReader } from './queue-stats.js';

function createQueueStats(config: IntegrationConfig): QueueStatsReader {
  return config.syncQueueUrl && config.syncDlqUrl
    ? new SqsQueueStats(new SQSClient({}), config.syncQueueUrl, config.syncDlqUrl)
    : new NoQueueStats();
}

/** /admin/* for the dashboard. The dispatcher comes from IntakeModule (replay re-queues). */
@Module({
  imports: [SyncLogModule, IntakeModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    ApiKeyGuard,
    { provide: QUEUE_STATS, useFactory: createQueueStats, inject: [INTEGRATION_CONFIG] },
  ],
})
export class AdminModule {}

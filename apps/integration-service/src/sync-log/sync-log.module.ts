import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Module } from '@nestjs/common';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { DynamoDbSyncLogRepository } from './dynamodb-sync-log.repository.js';
import { InMemorySyncLogRepository } from './in-memory-sync-log.repository.js';
import { SyncLogService } from './sync-log.service.js';
import { SYNC_LOG_REPOSITORY, type SyncLogRepository } from './sync-record.js';

/** DynamoDB when a table is configured (on AWS), memory otherwise (local, tests). */
function createRepository(config: IntegrationConfig): SyncLogRepository {
  return config.syncLogTable
    ? new DynamoDbSyncLogRepository(new DynamoDBClient({}), config.syncLogTable)
    : new InMemorySyncLogRepository();
}

@Module({
  providers: [
    { provide: SYNC_LOG_REPOSITORY, useFactory: createRepository, inject: [INTEGRATION_CONFIG] },
    SyncLogService,
  ],
  exports: [SyncLogService, SYNC_LOG_REPOSITORY],
})
export class SyncLogModule {}

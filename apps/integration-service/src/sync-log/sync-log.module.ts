import { Module } from '@nestjs/common';
import { InMemorySyncLogRepository } from './in-memory-sync-log.repository.js';
import { SyncLogService } from './sync-log.service.js';
import { SYNC_LOG_REPOSITORY } from './sync-record.js';

@Module({
  providers: [{ provide: SYNC_LOG_REPOSITORY, useFactory: () => new InMemorySyncLogRepository() }, SyncLogService],
  exports: [SyncLogService, SYNC_LOG_REPOSITORY],
})
export class SyncLogModule {}

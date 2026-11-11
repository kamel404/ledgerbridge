import { Module } from '@nestjs/common';
import { FlowsModule } from '../flows/flows.module.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { SyncWorker } from './sync-worker.js';

@Module({
  imports: [FlowsModule, SyncLogModule],
  providers: [SyncWorker],
  exports: [SyncWorker],
})
export class WorkerModule {}

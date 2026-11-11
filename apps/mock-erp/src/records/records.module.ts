import { Module } from '@nestjs/common';
import { InMemoryRecordStore } from './in-memory-record-store.js';
import { RECORD_STORE } from './record-store.js';
import { RecordsController } from './records.controller.js';
import { RecordsService } from './records.service.js';

@Module({
  controllers: [RecordsController],
  providers: [
    RecordsService,
    // Phase 3 picks DynamoDbRecordStore here when running on AWS.
    { provide: RECORD_STORE, useClass: InMemoryRecordStore },
  ],
  exports: [RecordsService],
})
export class RecordsModule {}

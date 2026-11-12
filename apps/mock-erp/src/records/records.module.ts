import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Module } from '@nestjs/common';
import { MOCK_ERP_CONFIG, type MockErpConfig } from '../config/mock-erp.config.js';
import { DynamoDbRecordStore } from './dynamodb-record-store.js';
import { InMemoryRecordStore } from './in-memory-record-store.js';
import { RECORD_STORE, type RecordStore } from './record-store.js';
import { RecordsController } from './records.controller.js';
import { RecordsService } from './records.service.js';

/** DynamoDB when a table is configured (on AWS), memory otherwise (local, tests). */
function createRecordStore(config: MockErpConfig): RecordStore {
  return config.tableName
    ? new DynamoDbRecordStore(new DynamoDBClient({}), config.tableName)
    : new InMemoryRecordStore();
}

@Module({
  controllers: [RecordsController],
  providers: [
    RecordsService,
    { provide: RECORD_STORE, useFactory: createRecordStore, inject: [MOCK_ERP_CONFIG] },
  ],
  exports: [RecordsService],
})
export class RecordsModule {}

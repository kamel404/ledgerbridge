import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module.js';
import { SuiteQlController } from './suiteql.controller.js';
import { SuiteQlService } from './suiteql.service.js';

@Module({
  imports: [RecordsModule],
  controllers: [SuiteQlController],
  providers: [SuiteQlService],
})
export class SuiteQlModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { ChaosModule } from './chaos/chaos.module.js';
import { NetSuiteErrorFilter } from './common/netsuite-error.filter.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { RecordsModule } from './records/records.module.js';
import { SuiteQlModule } from './suiteql/suiteql.module.js';

@Module({
  imports: [ConfigModule, HealthModule, AuthModule, ChaosModule, RecordsModule, SuiteQlModule],
  providers: [{ provide: APP_FILTER, useClass: NetSuiteErrorFilter }],
})
export class AppModule {}

import { Global, Module } from '@nestjs/common';
import { MOCK_ERP_CONFIG, loadConfig } from './mock-erp.config.js';

@Global()
@Module({
  providers: [{ provide: MOCK_ERP_CONFIG, useFactory: () => loadConfig() }],
  exports: [MOCK_ERP_CONFIG],
})
export class ConfigModule {}

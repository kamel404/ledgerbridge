import { Global, Module } from '@nestjs/common';
import { INTEGRATION_CONFIG, loadConfig } from './integration.config.js';

@Global()
@Module({
  providers: [{ provide: INTEGRATION_CONFIG, useFactory: () => loadConfig() }],
  exports: [INTEGRATION_CONFIG],
})
export class ConfigModule {}

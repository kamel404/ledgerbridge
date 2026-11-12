import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { IntakeModule } from '../intake/intake.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { CsvImportService } from './csv-import.service.js';

@Module({
  imports: [IntakeModule],
  providers: [CsvImportService],
  exports: [CsvImportService],
})
export class CsvModule {}

/**
 * Root module of the CSV Lambda (no HTTP server). Secrets are only there
 * because the local inline dispatcher can run the worker; on AWS this Lambda
 * just queues events and never calls the ERP.
 */
@Module({
  imports: [ConfigModule, SecretsModule, CsvModule],
})
export class CsvAppModule {}

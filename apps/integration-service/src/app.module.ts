import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { IngestModule } from './ingest/ingest.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { SecretsModule } from './secrets/secrets.module.js';

@Module({
  imports: [ConfigModule, ObservabilityModule, SecretsModule, HealthModule, IngestModule, AdminModule],
})
export class AppModule {}

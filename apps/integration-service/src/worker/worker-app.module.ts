import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { WorkerModule } from './worker.module.js';

/**
 * Root module of the worker Lambda: config, secrets and the worker, but no
 * HTTP controllers (it's started with createApplicationContext, no server).
 */
@Module({
  imports: [ConfigModule, SecretsModule, WorkerModule],
})
export class WorkerAppModule {}

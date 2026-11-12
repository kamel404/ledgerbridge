import { Global, Module } from '@nestjs/common';
import { isLambda } from './json-logger.js';
import { NoopSyncMetrics, PowertoolsSyncMetrics, SYNC_METRICS } from './sync-metrics.js';

/** Metrics on Lambda, a no-op locally and in tests. */
@Global()
@Module({
  providers: [{ provide: SYNC_METRICS, useFactory: () => (isLambda() ? new PowertoolsSyncMetrics() : new NoopSyncMetrics()) }],
  exports: [SYNC_METRICS],
})
export class ObservabilityModule {}

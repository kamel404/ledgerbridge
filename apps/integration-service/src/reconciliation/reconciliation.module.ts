import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { ErpClientModule } from '../erp-client/erp-client.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import { Reconciler } from './reconciler.js';
import {
  DynamoDbReconciliationStore,
  InMemoryReconciliationStore,
  RECONCILIATION_STORE,
  type ReconciliationStore,
} from './reconciliation-store.js';

/** DynamoDB when a table is configured (on AWS), memory otherwise (local, tests). */
function createStore(config: IntegrationConfig): ReconciliationStore {
  return config.reconciliationTable
    ? new DynamoDbReconciliationStore(new DynamoDBClient({}), config.reconciliationTable)
    : new InMemoryReconciliationStore();
}

/** Just the store: the admin API reads the latest run from it. */
@Module({
  providers: [{ provide: RECONCILIATION_STORE, useFactory: createStore, inject: [INTEGRATION_CONFIG] }],
  exports: [RECONCILIATION_STORE],
})
export class ReconciliationStoreModule {}

@Module({
  imports: [SyncLogModule, ErpClientModule, ReconciliationStoreModule],
  providers: [Reconciler],
  exports: [Reconciler],
})
export class ReconciliationModule {}

/** Root module of the reconcile Lambda (no HTTP server). */
@Module({
  imports: [ConfigModule, ObservabilityModule, SecretsModule, ReconciliationModule],
})
export class ReconcileAppModule {}

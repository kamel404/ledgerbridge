import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Global, Module } from '@nestjs/common';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { EnvSecretsProvider } from './env-secrets.provider.js';
import { SecretsManagerProvider } from './secrets-manager.provider.js';
import { SECRETS_PROVIDER, type SecretsProvider } from './secrets-provider.js';

/** Secrets Manager when a secret name is configured (on AWS), env vars otherwise (local). */
function createSecretsProvider(config: IntegrationConfig): SecretsProvider {
  if (config.webhookSecretName || config.erpSecretName || config.adminSecretName) {
    return new SecretsManagerProvider(new SecretsManagerClient({}), {
      webhooks: config.webhookSecretName,
      erp: config.erpSecretName,
      admin: config.adminSecretName,
    });
  }
  return new EnvSecretsProvider();
}

@Global()
@Module({
  providers: [{ provide: SECRETS_PROVIDER, useFactory: createSecretsProvider, inject: [INTEGRATION_CONFIG] }],
  exports: [SECRETS_PROVIDER],
})
export class SecretsModule {}

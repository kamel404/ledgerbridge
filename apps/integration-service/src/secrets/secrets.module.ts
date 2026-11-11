import { Global, Module } from '@nestjs/common';
import { EnvSecretsProvider } from './env-secrets.provider.js';
import { SECRETS_PROVIDER } from './secrets-provider.js';

@Global()
@Module({
  providers: [{ provide: SECRETS_PROVIDER, useFactory: () => new EnvSecretsProvider() }],
  exports: [SECRETS_PROVIDER],
})
export class SecretsModule {}

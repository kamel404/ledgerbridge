import type { ErpCredentials, SecretsProvider, WebhookSource } from './secrets-provider.js';

const WEBHOOK_ENV: Record<WebhookSource, string> = {
  billing: 'WEBHOOK_SECRET_BILLING',
  procurement: 'WEBHOOK_SECRET_PROCUREMENT',
};

/**
 * Local development only: reads secrets from environment variables (.env).
 * Fails loudly on a missing value instead of silently using an empty secret,
 * which would make every signature check meaningless.
 */
export class EnvSecretsProvider implements SecretsProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async webhookSecret(source: WebhookSource): Promise<string> {
    return this.required(WEBHOOK_ENV[source]);
  }

  async erpCredentials(): Promise<ErpCredentials> {
    return {
      clientId: this.required('MOCK_ERP_CLIENT_ID'),
      clientSecret: this.required('MOCK_ERP_CLIENT_SECRET'),
    };
  }

  async adminApiKey(): Promise<string> {
    return this.required('ADMIN_API_KEY');
  }

  private required(name: string): string {
    const value = this.env[name];
    if (!value) throw new Error(`Missing secret: environment variable ${name} is not set`);
    return value;
  }
}

import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { ErpCredentials, SecretsProvider, WebhookSource } from './secrets-provider.js';

/** How long a fetched secret is reused before asking Secrets Manager again. */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  value: Record<string, unknown>;
  fetchedAt: number;
}

/**
 * On AWS: reads secrets from AWS Secrets Manager at runtime and caches them in
 * memory for the life of the warm Lambda (re-fetched every 5 minutes, so a
 * changed secret is picked up without a redeploy).
 *
 * The Lambda only knows the secret's *name* (env var) and has IAM permission
 * to read just that secret. The value never sits in code, Git, or the
 * Lambda's environment variables.
 *
 * Each secret is one JSON object, to keep the number of secrets (and their
 * monthly cost) small:
 *   ledgerbridge/webhooks  {"billing": "...", "procurement": "..."}
 *   ledgerbridge/erp       {"clientId": "...", "clientSecret": "..."}   (Phase 4)
 */
export class SecretsManagerProvider implements SecretsProvider {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: SecretsManagerClient,
    private readonly names: { webhooks?: string; erp?: string },
  ) {}

  async webhookSecret(source: WebhookSource): Promise<string> {
    const secret = await this.read(this.require('webhooks'));
    return this.field(secret, source, this.names.webhooks!);
  }

  async erpCredentials(): Promise<ErpCredentials> {
    const secret = await this.read(this.require('erp'));
    return {
      clientId: this.field(secret, 'clientId', this.names.erp!),
      clientSecret: this.field(secret, 'clientSecret', this.names.erp!),
    };
  }

  private require(kind: 'webhooks' | 'erp'): string {
    const name = this.names[kind];
    if (!name) throw new Error(`No Secrets Manager secret configured for ${kind}`);
    return name;
  }

  private async read(name: string): Promise<Record<string, unknown>> {
    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

    const res = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
    let value: unknown;
    try {
      value = JSON.parse(res.SecretString ?? '');
    } catch {
      throw new Error(`Secret ${name} is not a JSON object`);
    }
    if (typeof value !== 'object' || value === null) throw new Error(`Secret ${name} is not a JSON object`);
    this.cache.set(name, { value: value as Record<string, unknown>, fetchedAt: Date.now() });
    return value as Record<string, unknown>;
  }

  private field(secret: Record<string, unknown>, key: string, name: string): string {
    const v = secret[key];
    // Never include the value in the message, only which key is missing.
    if (typeof v !== 'string' || !v) throw new Error(`Secret ${name} has no "${key}" value`);
    return v;
  }
}

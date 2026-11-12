import type { Source } from '@ledgerbridge/shared';

/** Sources that call us over a signed webhook (CSV import has no webhook). */
export type WebhookSource = Exclude<Source, 'csv'>;
export const WEBHOOK_SOURCES = ['billing', 'procurement'] as const satisfies readonly WebhookSource[];

export function isWebhookSource(value: string): value is WebhookSource {
  return (WEBHOOK_SOURCES as readonly string[]).includes(value);
}

export interface ErpCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Where secrets come from. The code only ever asks this interface, so moving
 * from env vars (local) to AWS Secrets Manager (Phase 4) swaps one provider
 * and touches nothing else.
 */
export interface SecretsProvider {
  /** HMAC secret shared with one source app. */
  webhookSecret(source: WebhookSource): Promise<string>;
  /** OAuth client credentials for the ERP. */
  erpCredentials(): Promise<ErpCredentials>;
  /** The key callers of /admin/* must send in X-Api-Key. */
  adminApiKey(): Promise<string>;
}

export const SECRETS_PROVIDER = Symbol('SECRETS_PROVIDER');

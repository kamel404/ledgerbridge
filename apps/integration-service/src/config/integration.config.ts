import { z } from 'zod';

/**
 * Settings of the integration service, read once from environment variables.
 * Secrets are NOT here: they come from a SecretsProvider (env vars locally,
 * Secrets Manager in AWS from Phase 4).
 */
const EnvSchema = z.object({
  /** Where the ERP lives. Pointing at real NetSuite later is a config change. */
  ERP_BASE_URL: z.url().default('http://localhost:3001'),
  /** Per-request timeout for ERP calls (SPEC §8.4: 10 s). */
  ERP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Max age of a webhook's X-Timestamp (SPEC §8.1: 5 minutes). */
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
});

export interface IntegrationConfig {
  erpBaseUrl: string;
  erpTimeoutMs: number;
  webhookToleranceSeconds: number;
}

export const INTEGRATION_CONFIG = Symbol('INTEGRATION_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IntegrationConfig {
  // Treat empty strings as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid integration-service configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    erpBaseUrl: e.ERP_BASE_URL.replace(/\/+$/, ''),
    erpTimeoutMs: e.ERP_TIMEOUT_MS,
    webhookToleranceSeconds: e.WEBHOOK_TOLERANCE_SECONDS,
  };
}

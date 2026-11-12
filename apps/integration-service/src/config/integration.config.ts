import { z } from 'zod';

/**
 * Settings of the integration service, read once from environment variables.
 * Secret *values* are NOT here: they come from a SecretsProvider (env vars
 * locally, Secrets Manager on AWS). Only secret *names* are.
 *
 * On AWS, CDK sets the table/queue/secret names on each Lambda. Locally they
 * are unset, and the service falls back to in-memory storage, inline
 * processing and secrets from .env.
 */
const EnvSchema = z.object({
  /** Where the ERP lives. Pointing at real NetSuite later is a config change. */
  ERP_BASE_URL: z.url().default('http://localhost:3001'),
  /** Per-request timeout for ERP calls (SPEC §8.4: 10 s). */
  ERP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Max age of a webhook's X-Timestamp (SPEC §8.1: 5 minutes). */
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  /** DynamoDB SyncLog table. Unset = in-memory sync log. */
  SYNC_LOG_TABLE: z.string().min(1).optional(),
  /** SQS queue URL. Unset = process events inline (no queue). */
  SYNC_QUEUE_URL: z.url().optional(),
  /** Secrets Manager secret holding {"billing": "...", "procurement": "..."}. Unset = env vars. */
  WEBHOOK_SECRET_NAME: z.string().min(1).optional(),
  /** Secrets Manager secret holding {"clientId": "...", "clientSecret": "..."} (Phase 4). */
  ERP_SECRET_NAME: z.string().min(1).optional(),
  /** Secrets Manager secret holding {"apiKey": "..."} for the admin API. Unset = ADMIN_API_KEY env var. */
  ADMIN_SECRET_NAME: z.string().min(1).optional(),
  /** Dead-letter queue URL, for the DLQ depth on the dashboard. Unset = no queue stats. */
  SYNC_DLQ_URL: z.url().optional(),
  /** DynamoDB table with reconciliation results. Unset = kept in memory. */
  RECONCILIATION_TABLE: z.string().min(1).optional(),
});

export interface IntegrationConfig {
  erpBaseUrl: string;
  erpTimeoutMs: number;
  webhookToleranceSeconds: number;
  syncLogTable?: string;
  syncQueueUrl?: string;
  webhookSecretName?: string;
  erpSecretName?: string;
  adminSecretName?: string;
  syncDlqUrl?: string;
  reconciliationTable?: string;
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
    ...(e.SYNC_LOG_TABLE && { syncLogTable: e.SYNC_LOG_TABLE }),
    ...(e.SYNC_QUEUE_URL && { syncQueueUrl: e.SYNC_QUEUE_URL }),
    ...(e.WEBHOOK_SECRET_NAME && { webhookSecretName: e.WEBHOOK_SECRET_NAME }),
    ...(e.ERP_SECRET_NAME && { erpSecretName: e.ERP_SECRET_NAME }),
    ...(e.ADMIN_SECRET_NAME && { adminSecretName: e.ADMIN_SECRET_NAME }),
    ...(e.SYNC_DLQ_URL && { syncDlqUrl: e.SYNC_DLQ_URL }),
    ...(e.RECONCILIATION_TABLE && { reconciliationTable: e.RECONCILIATION_TABLE }),
  };
}

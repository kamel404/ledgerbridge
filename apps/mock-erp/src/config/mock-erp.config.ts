import { z } from 'zod';

/**
 * All settings of the mock ERP, read once from environment variables.
 * Defaults are for local development only (they match .env.example).
 */
const EnvSchema = z.object({
  MOCK_ERP_CLIENT_ID: z.string().min(1).default('local-client'),
  MOCK_ERP_CLIENT_SECRET: z.string().min(1).default('local-dev-secret-change-me'),
  MOCK_ERP_JWT_SECRET: z.string().min(16).default('local-jwt-signing-key-change-me'),
  MOCK_ERP_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Fraction of ERP requests answered with 503, from 0 to 1. */
  CHAOS_ERROR_RATE: z.coerce.number().min(0).max(1).default(0),
  /** Extra delay added to every ERP request, in milliseconds. */
  CHAOS_LATENCY_MS: z.coerce.number().int().min(0).default(0),
  /** Max ERP requests per second before 429. 0 turns the limit off. */
  RATE_LIMIT_PER_SECOND: z.coerce.number().int().min(0).default(25),
  /** DynamoDB table for records. Unset = in-memory store (local development). */
  MOCK_ERP_TABLE_NAME: z.string().min(1).optional(),
});

export interface MockErpConfig {
  clientId: string;
  clientSecret: string;
  jwtSecret: string;
  tokenTtlSeconds: number;
  chaos: ChaosSettings;
  /** Set on AWS: records live in this DynamoDB table instead of memory. */
  tableName?: string;
}

export interface ChaosSettings {
  errorRate: number;
  latencyMs: number;
  rateLimitPerSecond: number;
}

export const MOCK_ERP_CONFIG = Symbol('MOCK_ERP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MockErpConfig {
  // Treat empty strings as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid mock ERP configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    clientId: e.MOCK_ERP_CLIENT_ID,
    clientSecret: e.MOCK_ERP_CLIENT_SECRET,
    jwtSecret: e.MOCK_ERP_JWT_SECRET,
    tokenTtlSeconds: e.MOCK_ERP_TOKEN_TTL_SECONDS,
    chaos: {
      errorRate: e.CHAOS_ERROR_RATE,
      latencyMs: e.CHAOS_LATENCY_MS,
      rateLimitPerSecond: e.RATE_LIMIT_PER_SECOND,
    },
    ...(e.MOCK_ERP_TABLE_NAME && { tableName: e.MOCK_ERP_TABLE_NAME }),
  };
}

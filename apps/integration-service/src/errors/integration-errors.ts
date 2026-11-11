import type { ErrorClass } from '@ledgerbridge/shared';

/**
 * The two kinds of failure the worker cares about (SPEC §8.2):
 *
 * - RetryableError: might work later (ERP down, rate limited, timeout,
 *   invoice not arrived yet). The message goes back to the queue.
 * - PermanentError: will fail again however often we try (bad data, unknown
 *   mapping, business rule). A human has to fix something first.
 *
 * Every error carries a stable `code` (e.g. UNKNOWN_SKU, ERP_INVALID_REFERENCE)
 * that the dashboard and alarms can group on.
 */
export abstract class IntegrationError extends Error {
  abstract readonly errorClass: ErrorClass;

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RetryableError extends IntegrationError {
  readonly errorClass = 'retryable' as const;
  /** From the ERP's Retry-After header on 429. Phase 4 uses it to delay the message. */
  readonly retryAfterSeconds?: number;

  constructor(code: string, message: string, options?: { cause?: unknown; retryAfterSeconds?: number }) {
    super(code, message, options);
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export class PermanentError extends IntegrationError {
  readonly errorClass = 'permanent' as const;
}

/** What the sync log stores as `lastError` (SPEC §8.5). */
export interface ErrorSummary {
  code: string;
  message: string;
  class: ErrorClass;
}

/**
 * Turns anything thrown into an ErrorSummary. Errors we didn't anticipate
 * (bugs, unexpected exceptions) count as retryable: if they keep failing they
 * end in the DLQ and can be replayed once fixed, instead of being dropped.
 */
export function classifyError(err: unknown): ErrorSummary {
  if (err instanceof IntegrationError) {
    return { code: err.code, message: err.message, class: err.errorClass };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'UNEXPECTED_ERROR', message, class: 'retryable' };
}

import { PermanentError, RetryableError, type IntegrationError } from '../errors/integration-errors.js';

/** NetSuite's error body: { type, title, status, "o:errorDetails": [{ detail, "o:errorCode" }] }. */
interface NetSuiteErrorBody {
  title?: string;
  'o:errorDetails'?: { detail?: string; 'o:errorCode'?: string }[];
  // OAuth errors from the token endpoint use this shape instead.
  error?: string;
  error_description?: string;
}

/**
 * Turns a failed ERP response into the right error class (SPEC §8.2, §8.4):
 *
 *   429                      -> retryable (ERP_RATE_LIMITED, with Retry-After)
 *   5xx, 408                 -> retryable (ERP down or overloaded)
 *   401 (after one refresh)  -> retryable (ERP_AUTH_FAILED): usually rotated
 *                               credentials; retries pick up the new secret,
 *                               and if not, the message ends in the DLQ
 *   other 4xx                -> permanent: the ERP rejected our data, so the
 *                               same request will be rejected again
 *
 * The NetSuite error code becomes part of ours: INVALID_REFERENCE -> ERP_INVALID_REFERENCE.
 */
export function erpErrorFromResponse(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): IntegrationError {
  const { erpCode, detail } = readErrorBody(body);
  const message = `ERP returned ${status}${detail ? `: ${detail}` : ''}`;

  if (status === 429) {
    return new RetryableError('ERP_RATE_LIMITED', message, {
      retryAfterSeconds: parseRetryAfter(retryAfterHeader),
    });
  }
  if (status >= 500 || status === 408) {
    return new RetryableError(`ERP_${erpCode ?? 'SERVER_ERROR'}`, message);
  }
  if (status === 401) {
    return new RetryableError('ERP_AUTH_FAILED', message);
  }
  return new PermanentError(`ERP_${erpCode ?? 'BAD_REQUEST'}`, message);
}

function readErrorBody(body: unknown): { erpCode?: string; detail?: string } {
  if (typeof body !== 'object' || body === null) {
    return { detail: typeof body === 'string' && body ? body.slice(0, 500) : undefined };
  }
  const b = body as NetSuiteErrorBody;
  const first = b['o:errorDetails']?.[0];
  if (first) return { erpCode: first['o:errorCode'], detail: first.detail };
  if (b.error) return { erpCode: b.error.toUpperCase(), detail: b.error_description ?? b.error };
  return { detail: b.title };
}

/** Retry-After is either seconds ("30") or an HTTP date. Returns whole seconds, at least 1. */
export function parseRetryAfter(header?: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(1, Number(trimmed));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(1, Math.ceil((date - now) / 1000));
}

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (SPEC §8.1):
 *
 *   X-Timestamp: unix time in seconds when the sender signed the request
 *   X-Signature: hex HMAC-SHA256(secret, "<X-Timestamp>.<raw body>")
 *
 * The raw body is the exact bytes received: re-serialised JSON can differ by
 * a space or key order and would never match.
 */

export function computeSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export type SignatureFailure = 'MISSING_HEADERS' | 'INVALID_TIMESTAMP' | 'TIMESTAMP_OUT_OF_RANGE' | 'INVALID_SIGNATURE';

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

export interface SignatureInput {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  /** Max allowed difference between X-Timestamp and now (default 5 minutes). */
  toleranceSeconds?: number;
  nowMs?: number;
}

export function verifySignature(input: SignatureInput): SignatureCheck {
  const { secret, timestamp, signature, rawBody, toleranceSeconds = 300, nowMs = Date.now() } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'MISSING_HEADERS' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'INVALID_TIMESTAMP' };

  // Too old = possible replay of a captured request. Too far in the future is
  // refused too, otherwise a forged future timestamp would stay valid for long.
  const ageSeconds = nowMs / 1000 - Number(timestamp);
  if (Math.abs(ageSeconds) > toleranceSeconds) return { ok: false, reason: 'TIMESTAMP_OUT_OF_RANGE' };

  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: 'INVALID_SIGNATURE' };
  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex');
  const received = Buffer.from(signature, 'hex');
  // Constant-time compare: `===` stops at the first wrong character, and that
  // timing difference lets an attacker guess a valid signature byte by byte.
  if (!timingSafeEqual(expected, received)) return { ok: false, reason: 'INVALID_SIGNATURE' };
  return { ok: true };
}

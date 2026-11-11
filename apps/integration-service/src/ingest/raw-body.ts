import { raw, type Request } from 'express';
import type { INestApplication } from '@nestjs/common';

export const WEBHOOK_BODY_LIMIT = '1mb';

/**
 * Webhook routes get the body as raw bytes (a Buffer), never pre-parsed JSON:
 * - the HMAC is computed over the exact bytes received,
 * - malformed JSON reaches our code, so it can be logged as REJECTED instead
 *   of being answered by the JSON parser before we see it.
 * Must be applied before app.init() so it runs ahead of Nest's JSON parser.
 */
export function useRawWebhookBodies(app: INestApplication): void {
  app.use('/webhooks', raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }));
}

/** The exact request bytes, whichever parser ran. */
export function rawBodyOf(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  const fromNest = (req as Request & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(fromNest) ? fromNest : Buffer.alloc(0);
}

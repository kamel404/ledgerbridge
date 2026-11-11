import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { useRawWebhookBodies } from './ingest/raw-body.js';

/**
 * Builds the Nest app. Used by both the local server (main.ts) and the
 * Lambda handler (lambda/http.ts) so they can never drift apart.
 * rawBody keeps the exact request bytes, needed for HMAC signature checks.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  return app;
}

/** Settings shared by createApp and the e2e tests. Call before app.init(). */
export function configureApp(app: INestApplication): void {
  useRawWebhookBodies(app);
}

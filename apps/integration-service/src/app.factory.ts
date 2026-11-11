import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module.js';

/**
 * Builds the Nest app. Used by both the local server (main.ts) and the
 * Lambda handler (lambda/http.ts) so they can never drift apart.
 * rawBody keeps the exact request bytes, needed for HMAC signature checks.
 */
export async function createApp(): Promise<INestApplication> {
  return NestFactory.create(AppModule, { rawBody: true });
}

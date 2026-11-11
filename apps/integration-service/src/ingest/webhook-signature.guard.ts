import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { SECRETS_PROVIDER, isWebhookSource, type SecretsProvider } from '../secrets/secrets-provider.js';
import { rawBodyOf } from './raw-body.js';
import { verifySignature } from './signature.js';

/**
 * Runs before the webhook controller: unknown source -> 404, bad or expired
 * signature -> 401. Nothing is written to the sync log for a 401: an
 * unauthenticated caller must not be able to fill our storage.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const source = String(req.params.source);
    if (!isWebhookSource(source)) throw new NotFoundException(`Unknown webhook source '${source}'`);

    const check = verifySignature({
      secret: await this.secrets.webhookSecret(source),
      timestamp: req.header('x-timestamp'),
      signature: req.header('x-signature'),
      rawBody: rawBodyOf(req),
      toleranceSeconds: this.config.webhookToleranceSeconds,
    });
    if (!check.ok) {
      throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', reason: check.reason });
    }
    return true;
  }
}

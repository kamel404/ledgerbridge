import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { SECRETS_PROVIDER, type SecretsProvider } from '../secrets/secrets-provider.js';

/** Header the dashboard sends the admin key in. */
export const API_KEY_HEADER = 'x-api-key';

/**
 * Protects /admin/*: the X-Api-Key header must equal the admin key
 * (Secrets Manager `ledgerbridge/admin` on AWS, ADMIN_API_KEY locally).
 *
 * Both values are hashed to the same length first, then compared with
 * timingSafeEqual, so neither the comparison time nor a length check
 * reveals anything about the key.
 *
 * No key configured (e.g. the webhook Lambda, which isn't given the admin
 * secret) -> 503: the admin API is closed, not open.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(@Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const given = req.header(API_KEY_HEADER);

    let expected: string;
    try {
      expected = await this.secrets.adminApiKey();
    } catch (err) {
      this.logger.error(`Admin API key unavailable: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException('Admin API is not configured');
    }

    if (!given || !timingSafeEqual(sha256(given), sha256(expected))) {
      throw new UnauthorizedException('Missing or wrong X-Api-Key');
    }
    return true;
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

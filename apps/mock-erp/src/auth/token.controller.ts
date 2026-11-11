import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { Public } from '../common/public.decorator.js';
import { TokenService, type TokenRequest, type TokenResponse } from './token.service.js';

/**
 * POST /services/rest/auth/oauth2/v1/token
 *
 * Body is form-encoded (OAuth standard) or JSON:
 *   grant_type=client_credentials&client_id=...&client_secret=...
 * Client ID and secret may also come as HTTP Basic auth instead.
 */
@Controller('services/rest/auth/oauth2/v1')
export class TokenController {
  constructor(private readonly tokens: TokenService) {}

  @Public()
  @Post('token')
  @HttpCode(200)
  token(
    @Body() body: Record<string, unknown> | undefined,
    @Headers('authorization') authorization?: string,
  ): Promise<TokenResponse> {
    const fromBasic = parseBasicAuth(authorization);
    const req: TokenRequest = {
      grantType: asString(body?.grant_type),
      clientId: fromBasic?.clientId ?? asString(body?.client_id),
      clientSecret: fromBasic?.clientSecret ?? asString(body?.client_secret),
    };
    return this.tokens.issue(req);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseBasicAuth(header?: string): { clientId: string; clientSecret: string } | undefined {
  if (!header?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return undefined;
  return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
}

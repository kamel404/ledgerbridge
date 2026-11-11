import { Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual, createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { MOCK_ERP_CONFIG, type MockErpConfig } from '../config/mock-erp.config.js';
import { NetSuiteError } from '../common/netsuite-error.js';
import { OAuthError } from '../common/oauth-error.js';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface TokenRequest {
  grantType?: string;
  clientId?: string;
  clientSecret?: string;
}

const ISSUER = 'ledgerbridge-mock-erp';
const AUDIENCE = 'mock-erp-rest';

/**
 * OAuth 2.0 client-credentials flow (SPEC §7.1).
 * Tokens are JWTs signed with HMAC-SHA256 using MOCK_ERP_JWT_SECRET.
 *
 * Real NetSuite differs: the client proves itself with a JWT assertion signed by
 * a certificate's private key instead of sending a plain client secret.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(MOCK_ERP_CONFIG) private readonly config: MockErpConfig) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  async issue(req: TokenRequest): Promise<TokenResponse> {
    if (req.grantType !== 'client_credentials') {
      throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be client_credentials');
    }
    if (!req.clientId || !req.clientSecret) {
      throw new OAuthError(400, 'invalid_request', 'client_id and client_secret are required');
    }
    const validId = safeEqual(req.clientId, this.config.clientId);
    const validSecret = safeEqual(req.clientSecret, this.config.clientSecret);
    if (!validId || !validSecret) {
      throw new OAuthError(401, 'invalid_client', 'Invalid client credentials');
    }

    const token = await new SignJWT({ scope: 'rest_webservices' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(req.clientId)
      .setIssuedAt()
      .setExpirationTime(`${this.config.tokenTtlSeconds}s`)
      .sign(this.key);

    return { access_token: token, token_type: 'Bearer', expires_in: this.config.tokenTtlSeconds };
  }

  /** Checks a Bearer token. Throws a 401 NetSuiteError if it is missing, forged or expired. */
  async verify(token: string): Promise<{ clientId: string }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      return { clientId: String(payload.sub) };
    } catch (err) {
      const detail =
        err instanceof joseErrors.JWTExpired ? 'The access token has expired' : 'Invalid access token';
      throw new NetSuiteError(401, 'INVALID_LOGIN', detail);
    }
  }
}

/** Constant-time string compare. Hashing first makes both inputs the same length. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

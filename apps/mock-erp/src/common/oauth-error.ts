/**
 * Error from the OAuth token endpoint. OAuth 2.0 (RFC 6749 §5.2) has its own
 * error format, different from the NetSuite record API:
 *
 *   { "error": "invalid_client", "error_description": "..." }
 */
export type OAuthErrorCode = 'invalid_request' | 'invalid_client' | 'unsupported_grant_type';

export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401,
    readonly code: OAuthErrorCode,
    readonly description: string,
  ) {
    super(description);
    this.name = 'OAuthError';
  }

  toBody(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

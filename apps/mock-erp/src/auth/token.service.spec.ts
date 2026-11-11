import { SignJWT } from 'jose';
import { NetSuiteError } from '../common/netsuite-error.js';
import { OAuthError } from '../common/oauth-error.js';
import { loadConfig } from '../config/mock-erp.config.js';
import { TokenService } from './token.service.js';

const config = loadConfig({});
const good = { grantType: 'client_credentials', clientId: config.clientId, clientSecret: config.clientSecret };

describe('TokenService', () => {
  const service = new TokenService(config);

  it('issues a Bearer token that verifies', async () => {
    const res = await service.issue(good);
    expect(res).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    await expect(service.verify(res.access_token)).resolves.toEqual({ clientId: config.clientId });
  });

  it('rejects a wrong secret with invalid_client (401)', async () => {
    const err = await service.issue({ ...good, clientSecret: 'nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ status: 401, code: 'invalid_client' });
  });

  it('rejects other grant types', async () => {
    const err = await service.issue({ ...good, grantType: 'password' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'unsupported_grant_type' });
  });

  it('rejects a token signed with another key', async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('ledgerbridge-mock-erp')
      .setAudience('mock-erp-rest')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-key-0123456789'));
    const err = await service.verify(forged).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetSuiteError);
    expect(err).toMatchObject({ status: 401, code: 'INVALID_LOGIN' });
  });

  it('rejects an expired token', async () => {
    const shortLived = new TokenService(loadConfig({ MOCK_ERP_TOKEN_TTL_SECONDS: '1' }));
    const { access_token } = await shortLived.issue(good);
    vi.useFakeTimers({ now: Date.now() + 5000 });
    try {
      const err = await shortLived.verify(access_token).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 401, detail: 'The access token has expired' });
    } finally {
      vi.useRealTimers();
    }
  });
});

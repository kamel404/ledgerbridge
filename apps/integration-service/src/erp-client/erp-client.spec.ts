import type { IntegrationConfig } from '../config/integration.config.js';
import type { SecretsProvider } from '../secrets/secrets-provider.js';
import { ErpClient, internalIdFromLocation, type FetchFn } from './erp-client.js';

const BASE = 'http://erp.test';
const config: IntegrationConfig = { erpBaseUrl: BASE, erpTimeoutMs: 50, webhookToleranceSeconds: 300 };
const secrets: SecretsProvider = {
  webhookSecret: async () => 'unused',
  erpCredentials: async () => ({ clientId: 'cid', clientSecret: 'csecret' }),
  adminApiKey: async () => 'unused',
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A scripted fake ERP. `routes` answers per "METHOD path" (path without host);
 * the token endpoint hands out token-1, token-2, ... unless overridden.
 */
function fakeErp(routes: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetchFn: FetchFn = async (input, init) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const key = `${call.method} ${url.slice(BASE.length).split('?')[0]}`;
    const route = routes[key];
    if (route) return route(call);
    if (key === 'POST /services/rest/auth/oauth2/v1/token') {
      return Response.json({ access_token: `token-${++tokens}`, token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response('no route', { status: 500 });
  };
  const client = new ErpClient(config, secrets, fetchFn);
  const dataCalls = () => calls.filter((c) => !c.url.includes('/oauth2/'));
  const tokenCalls = () => calls.filter((c) => c.url.includes('/oauth2/'));
  return { client, calls, dataCalls, tokenCalls };
}

const UPSERT_INVOICE = 'PUT /services/rest/record/v1/invoice/eid:INV-1042';
const created = (id: string) =>
  new Response(null, { status: 204, headers: { Location: `${BASE}/services/rest/record/v1/invoice/${id}` } });
const nsError = (status: number, code: string, headers: Record<string, string> = {}) =>
  Response.json({ title: 'x', status, 'o:errorDetails': [{ detail: `${code} detail`, 'o:errorCode': code }] }, {
    status,
    headers,
  });

describe('ErpClient', () => {
  afterEach(() => vi.useRealTimers());

  it('upserts with PUT eid:, a bearer token and a JSON body, and returns the internal ID', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => created('42') });

    await expect(erp.client.upsert('invoice', 'INV-1042', { tranId: 'INV-1042' })).resolves.toEqual({ id: '42' });

    const [token, put] = erp.calls;
    expect(token!.body).toBe('grant_type=client_credentials&client_id=cid&client_secret=csecret');
    expect(put).toMatchObject({
      method: 'PUT',
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      body: '{"tranId":"INV-1042"}',
    });
  });

  it('URL-encodes external IDs', async () => {
    const erp = fakeErp({ 'PUT /services/rest/record/v1/customer/eid:A%2FB%20C': () => created('1') });
    await expect(erp.client.upsert('customer', 'A/B C', {})).resolves.toEqual({ id: '1' });
  });

  it('reuses the cached token across calls', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => created('42') });
    await erp.client.upsert('invoice', 'INV-1042', {});
    await erp.client.upsert('invoice', 'INV-1042', {});
    expect(erp.tokenCalls()).toHaveLength(1);
  });

  it('shares one token request between concurrent calls', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => created('42') });
    await Promise.all([1, 2, 3].map(() => erp.client.upsert('invoice', 'INV-1042', {})));
    expect(erp.tokenCalls()).toHaveLength(1);
  });

  it('refreshes the token shortly before it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const erp = fakeErp({ [UPSERT_INVOICE]: () => created('42') });
    await erp.client.upsert('invoice', 'INV-1042', {});
    vi.setSystemTime(Date.now() + 3600_000 - 30_000); // 30 s before expiry
    await erp.client.upsert('invoice', 'INV-1042', {});
    expect(erp.tokenCalls()).toHaveLength(2);
  });

  it('on 401 gets a new token and retries once', async () => {
    const erp = fakeErp({
      [UPSERT_INVOICE]: (call) =>
        call.headers.Authorization === 'Bearer token-1' ? nsError(401, 'INVALID_LOGIN') : created('42'),
    });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).resolves.toEqual({ id: '42' });
    expect(erp.dataCalls().map((c) => c.headers.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('gives up after the second 401 with a retryable auth error', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => nsError(401, 'INVALID_LOGIN') });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_AUTH_FAILED',
      errorClass: 'retryable',
    });
    expect(erp.dataCalls()).toHaveLength(2);
  });

  it('turns a 400 into a permanent error with the ERP code', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => nsError(400, 'INVALID_REFERENCE') });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_INVALID_REFERENCE',
      errorClass: 'permanent',
      message: 'ERP returned 400: INVALID_REFERENCE detail',
    });
  });

  it('turns a 503 into a retryable error', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => nsError(503, 'SERVICE_UNAVAILABLE') });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_SERVICE_UNAVAILABLE',
      errorClass: 'retryable',
    });
  });

  it('turns a 429 into a retryable error with Retry-After', async () => {
    const erp = fakeErp({ [UPSERT_INVOICE]: () => nsError(429, 'REQUEST_LIMIT_EXCEEDED', { 'Retry-After': '2' }) });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_RATE_LIMITED',
      retryAfterSeconds: 2,
    });
  });

  it('a rate-limited token request is retryable too', async () => {
    const erp = fakeErp({
      'POST /services/rest/auth/oauth2/v1/token': () => nsError(429, 'REQUEST_LIMIT_EXCEEDED', { 'Retry-After': '1' }),
    });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({ code: 'ERP_RATE_LIMITED' });
  });

  it('wrong client credentials fail with a retryable auth error', async () => {
    const erp = fakeErp({
      'POST /services/rest/auth/oauth2/v1/token': () =>
        Response.json({ error: 'invalid_client', error_description: 'Invalid client credentials' }, { status: 401 }),
    });
    await expect(erp.client.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_AUTH_FAILED',
      errorClass: 'retryable',
    });
  });

  it('times out slow requests as retryable', async () => {
    // Never answers data requests; only the timeout signal (50 ms in this config) ends them.
    const slow = new ErpClient(config, secrets, async (input, init) => {
      if (String(input).includes('/oauth2/')) return Response.json({ access_token: 't', expires_in: 3600 });
      const signal = init!.signal!;
      return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    await expect(slow.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_TIMEOUT',
      errorClass: 'retryable',
    });
  });

  it('network failures are retryable', async () => {
    const down = new ErpClient(config, secrets, async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });
    await expect(down.upsert('invoice', 'INV-1042', {})).rejects.toMatchObject({
      code: 'ERP_UNREACHABLE',
      errorClass: 'retryable',
    });
  });

  it('getByExternalId returns the record, or undefined on 404', async () => {
    const erp = fakeErp({
      'GET /services/rest/record/v1/invoice/eid:INV-1042': () => Response.json({ id: '42', externalId: 'INV-1042' }),
      'GET /services/rest/record/v1/invoice/eid:INV-404': () => nsError(404, 'NONEXISTENT_ID'),
    });
    await expect(erp.client.getByExternalId('invoice', 'INV-1042')).resolves.toEqual({
      id: '42',
      externalId: 'INV-1042',
    });
    await expect(erp.client.getByExternalId('invoice', 'INV-404')).resolves.toBeUndefined();
  });

  it('runs SuiteQL with Prefer: transient and paging parameters', async () => {
    const page = { items: [{ tranid: 'INV-1042' }], count: 1, offset: 0, totalResults: 1, hasMore: false };
    const erp = fakeErp({ 'POST /services/rest/query/v1/suiteql': () => Response.json(page) });

    await expect(erp.client.suiteql('SELECT tranId FROM invoice', { limit: 10, offset: 0 })).resolves.toEqual(page);

    const call = erp.dataCalls()[0]!;
    expect(call.url).toBe(`${BASE}/services/rest/query/v1/suiteql?limit=10&offset=0`);
    expect(call.headers.Prefer).toBe('transient');
    expect(JSON.parse(call.body!)).toEqual({ q: 'SELECT tranId FROM invoice' });
  });
});

describe('internalIdFromLocation', () => {
  it('reads the trailing ID', () => {
    expect(internalIdFromLocation('http://x/services/rest/record/v1/invoice/42')).toBe('42');
  });
  it('returns undefined when there is none', () => {
    expect(internalIdFromLocation(null)).toBeUndefined();
    expect(internalIdFromLocation('http://x/services/rest/record/v1/invoice/eid:A')).toBeUndefined();
  });
});

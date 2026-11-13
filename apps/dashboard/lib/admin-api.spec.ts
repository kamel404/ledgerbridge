import { AdminApiError, adminApi, syncsQuery } from './admin-api';
import { resetSettingsCache } from './settings';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

describe('admin API client', () => {
  beforeEach(() => {
    vi.stubEnv('ADMIN_API_URL', 'https://api.example/');
    vi.stubEnv('ADMIN_API_KEY', 'k3y');
    resetSettingsCache();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends the key in X-Api-Key and never caches', async () => {
    const f = fakeFetch(200, { items: [] });
    await adminApi.listSyncs({ status: 'DEAD', q: 'INV 1' }, f);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.example/admin/syncs?status=DEAD&q=INV+1');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', headers: { 'X-Api-Key': 'k3y' } });
  });

  it('encodes event IDs that contain colons (CSV imports)', async () => {
    const f = fakeFetch(202, { syncId: 'x', status: 'RECEIVED' });
    await adminApi.replay('csv:abc:BILL-1', f);
    expect(f.mock.calls[0]![0]).toBe('https://api.example/admin/syncs/csv%3Aabc%3ABILL-1/replay');
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it("turns an error answer into AdminApiError with the API's message", async () => {
    const err = await adminApi.replay('e', fakeFetch(409, { message: 'this one is SUCCEEDED' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err).toMatchObject({ status: 409, message: 'this one is SUCCEEDED' });
  });

  it('explains what to do when not configured', async () => {
    vi.stubEnv('ADMIN_API_KEY', '');
    resetSettingsCache();
    await expect(adminApi.stats(fakeFetch(200, {}))).rejects.toThrow('npm run dashboard:env');
  });

  it('reports an unreachable API clearly', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(adminApi.stats(f)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('unreachable') });
  });

  it('builds query strings without empty filters', () => {
    expect(syncsQuery({})).toBe('');
    expect(syncsQuery({ status: 'FAILED', flow: undefined, q: '' })).toBe('?status=FAILED');
  });
});

import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SecretsManagerProvider } from './secrets-manager.provider.js';

function fakeClient(values: Record<string, string | undefined>) {
  const send = vi.fn(async (cmd: { input: { SecretId: string } }) => ({ SecretString: values[cmd.input.SecretId] }));
  return { client: { send } as unknown as SecretsManagerClient, send };
}

describe('SecretsManagerProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('reads one source secret from the JSON secret', async () => {
    const { client } = fakeClient({ 'lb/webhooks': '{"billing":"b-secret","procurement":"p-secret"}' });
    const provider = new SecretsManagerProvider(client, { webhooks: 'lb/webhooks' });
    await expect(provider.webhookSecret('billing')).resolves.toBe('b-secret');
    await expect(provider.webhookSecret('procurement')).resolves.toBe('p-secret');
  });

  it('caches the secret, and fetches it again after 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { client, send } = fakeClient({ 'lb/webhooks': '{"billing":"b","procurement":"p"}' });
    const provider = new SecretsManagerProvider(client, { webhooks: 'lb/webhooks' });

    await provider.webhookSecret('billing');
    await provider.webhookSecret('procurement');
    expect(send).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await provider.webhookSecret('billing');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reads ERP credentials', async () => {
    const { client } = fakeClient({ 'lb/erp': '{"clientId":"cid","clientSecret":"cs"}' });
    const provider = new SecretsManagerProvider(client, { erp: 'lb/erp' });
    await expect(provider.erpCredentials()).resolves.toEqual({ clientId: 'cid', clientSecret: 'cs' });
  });

  it('names the missing key without leaking any value', async () => {
    const { client } = fakeClient({ 'lb/webhooks': '{"billing":"top-secret-value"}' });
    const provider = new SecretsManagerProvider(client, { webhooks: 'lb/webhooks' });
    const err = (await provider.webhookSecret('procurement').catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('Secret lb/webhooks has no "procurement" value');
    expect(err.message).not.toContain('top-secret-value');
  });

  it('refuses a secret that is not JSON', async () => {
    const { client } = fakeClient({ 'lb/webhooks': 'plain-string' });
    const provider = new SecretsManagerProvider(client, { webhooks: 'lb/webhooks' });
    await expect(provider.webhookSecret('billing')).rejects.toThrow('is not a JSON object');
  });

  it('fails clearly when no secret is configured', async () => {
    const { client } = fakeClient({});
    await expect(new SecretsManagerProvider(client, {}).erpCredentials()).rejects.toThrow(
      'No Secrets Manager secret configured for erp',
    );
  });
});

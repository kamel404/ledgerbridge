import { createHmac } from 'node:crypto';
import { computeSignature, verifySignature } from './signature.js';

const secret = 'local-billing-secret';
const body = Buffer.from('{"id":"evt_1","type":"invoice.created"}');
const now = Date.parse('2026-11-11T10:00:00Z');
const ts = String(now / 1000);

function check(overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) {
  return verifySignature({
    secret,
    timestamp: ts,
    signature: computeSignature(secret, ts, body),
    rawBody: body,
    nowMs: now,
    ...overrides,
  });
}

describe('webhook signature', () => {
  it('accepts a correct signature', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('matches HMAC-SHA256 of "<timestamp>.<body>"', () => {
    // Independent of computeSignature's chunked update.
    const expected = createHmac('sha256', secret).update(`${ts}.${body.toString()}`).digest('hex');
    expect(computeSignature(secret, ts, body)).toBe(expected);
  });

  it('accepts an uppercase hex signature', () => {
    expect(check({ signature: computeSignature(secret, ts, body).toUpperCase() })).toEqual({ ok: true });
  });

  it('refuses a signature made with another secret', () => {
    expect(check({ signature: computeSignature('other-secret', ts, body) })).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it('refuses a body changed by one byte', () => {
    const tampered = Buffer.from(body.toString().replace('evt_1', 'evt_2'));
    expect(check({ rawBody: tampered })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('refuses re-serialised JSON (signature is over the raw bytes)', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(check({ rawBody: reformatted })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('refuses a signature of the wrong length without throwing', () => {
    expect(check({ signature: 'abc123' })).toMatchObject({ ok: false, reason: 'INVALID_SIGNATURE' });
  });

  it('refuses missing headers', () => {
    expect(check({ signature: undefined })).toMatchObject({ ok: false, reason: 'MISSING_HEADERS' });
    expect(check({ timestamp: undefined })).toMatchObject({ ok: false, reason: 'MISSING_HEADERS' });
  });

  it('refuses a timestamp that is not unix seconds', () => {
    expect(check({ timestamp: '2026-11-11T10:00:00Z' })).toMatchObject({ ok: false, reason: 'INVALID_TIMESTAMP' });
  });

  it('accepts a request 5 minutes old, refuses one older (replay protection)', () => {
    const signedAt = (secondsAgo: number) => {
      const t = String(now / 1000 - secondsAgo);
      return check({ timestamp: t, signature: computeSignature(secret, t, body) });
    };
    expect(signedAt(300)).toEqual({ ok: true });
    expect(signedAt(301)).toMatchObject({ ok: false, reason: 'TIMESTAMP_OUT_OF_RANGE' });
  });

  it('refuses a timestamp far in the future', () => {
    const t = String(now / 1000 + 3600);
    expect(check({ timestamp: t, signature: computeSignature(secret, t, body) })).toMatchObject({
      ok: false,
      reason: 'TIMESTAMP_OUT_OF_RANGE',
    });
  });
});

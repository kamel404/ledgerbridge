import { classifyError, PermanentError, RetryableError } from '../errors/integration-errors.js';
import { erpErrorFromResponse, parseRetryAfter } from './erp-errors.js';

const netsuiteBody = (status: number, code: string, detail: string) => ({
  type: 'https://example',
  title: 'x',
  status,
  'o:errorDetails': [{ detail, 'o:errorCode': code }],
});

describe('ERP error classification', () => {
  it('400 is permanent and keeps the ERP error code', () => {
    const err = erpErrorFromResponse(400, netsuiteBody(400, 'INVALID_REFERENCE', 'Invalid reference: customer CUS-99'));
    expect(err).toBeInstanceOf(PermanentError);
    expect(err).toMatchObject({ code: 'ERP_INVALID_REFERENCE' });
    expect(err.message).toContain('Invalid reference: customer CUS-99');
  });

  it('429 is retryable and carries Retry-After', () => {
    const err = erpErrorFromResponse(429, netsuiteBody(429, 'REQUEST_LIMIT_EXCEEDED', 'slow down'), '30');
    expect(err).toBeInstanceOf(RetryableError);
    expect(err).toMatchObject({ code: 'ERP_RATE_LIMITED', retryAfterSeconds: 30 });
  });

  it.each([500, 502, 503, 504])('%i is retryable', (status) => {
    expect(erpErrorFromResponse(status, netsuiteBody(status, 'SERVICE_UNAVAILABLE', 'down'))).toBeInstanceOf(
      RetryableError,
    );
  });

  it('a 5xx without a NetSuite body is still retryable', () => {
    expect(erpErrorFromResponse(502, '<html>Bad Gateway</html>')).toMatchObject({
      code: 'ERP_SERVER_ERROR',
      errorClass: 'retryable',
    });
  });

  it('401 after a token refresh is retryable (credentials may be rotating)', () => {
    expect(erpErrorFromResponse(401, { error: 'invalid_client' })).toMatchObject({
      code: 'ERP_AUTH_FAILED',
      errorClass: 'retryable',
    });
  });

  it('other 4xx are permanent', () => {
    expect(erpErrorFromResponse(404, netsuiteBody(404, 'RECORD_TYPE_NOT_FOUND', 'nope'))).toMatchObject({
      code: 'ERP_RECORD_TYPE_NOT_FOUND',
      errorClass: 'permanent',
    });
  });
});

describe('Retry-After parsing', () => {
  it('reads seconds', () => expect(parseRetryAfter('12')).toBe(12));
  it('never returns less than 1', () => expect(parseRetryAfter('0')).toBe(1));
  it('reads an HTTP date', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(parseRetryAfter('Wed, 11 Nov 2026 10:00:45 GMT', now)).toBe(45);
  });
  it('ignores garbage', () => expect(parseRetryAfter('soon')).toBeUndefined());
  it('ignores a missing header', () => expect(parseRetryAfter(null)).toBeUndefined());
});

describe('classifyError', () => {
  it('keeps code and class of our own errors', () => {
    expect(classifyError(new PermanentError('UNKNOWN_SKU', 'x'))).toEqual({
      code: 'UNKNOWN_SKU',
      message: 'x',
      class: 'permanent',
    });
  });

  it('treats unexpected errors as retryable, so they end in the DLQ rather than vanish', () => {
    expect(classifyError(new TypeError('boom'))).toEqual({
      code: 'UNEXPECTED_ERROR',
      message: 'boom',
      class: 'retryable',
    });
  });
});

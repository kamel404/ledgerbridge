/**
 * Errors in the shape NetSuite's REST API uses (SPEC §7.2):
 *
 *   { "type": "...", "title": "Bad Request", "status": 400,
 *     "o:errorDetails": [ { "detail": "...", "o:errorCode": "INVALID_REFERENCE" } ] }
 *
 * Throw a NetSuiteError anywhere; NetSuiteErrorFilter turns it into that body.
 */

export type NetSuiteErrorCode =
  | 'INVALID_CONTENT' // body fails validation
  | 'INVALID_REFERENCE' // a reference points at a missing record
  | 'DUPLICATE_EXTERNAL_ID' // POST with an externalId that already exists
  | 'NONEXISTENT_ID' // record not found
  | 'RECORD_TYPE_NOT_FOUND' // unknown record type in the URL
  | 'INVALID_OPERATION' // e.g. PUT with an internal ID
  | 'INVALID_AMOUNT' // business rule on money (overpayment, ...)
  | 'INVALID_SUITEQL' // query outside the supported grammar
  | 'INVALID_LOGIN' // missing / invalid / expired token
  | 'REQUEST_LIMIT_EXCEEDED' // rate limited (429)
  | 'SERVICE_UNAVAILABLE' // chaos 503
  | 'NOT_FOUND' // unknown route
  | 'UNEXPECTED_ERROR'; // bug

const STATUS_INFO: Record<number, { title: string; type: string }> = {
  400: { title: 'Bad Request', type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.1' },
  401: { title: 'Unauthorized', type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.2' },
  404: { title: 'Not Found', type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.5' },
  405: { title: 'Method Not Allowed', type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.6' },
  429: { title: 'Too Many Requests', type: 'https://www.rfc-editor.org/rfc/rfc6585.html#section-4' },
  500: { title: 'Internal Server Error', type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.1' },
  503: { title: 'Service Unavailable', type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.6.4' },
};

export interface NetSuiteErrorBody {
  type: string;
  title: string;
  status: number;
  'o:errorDetails': { detail: string; 'o:errorCode': NetSuiteErrorCode }[];
}

export class NetSuiteError extends Error {
  constructor(
    readonly status: number,
    readonly code: NetSuiteErrorCode,
    readonly detail: string,
    /** Extra response headers, e.g. Retry-After on 429. */
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
    this.name = 'NetSuiteError';
  }

  static badRequest(code: NetSuiteErrorCode, detail: string): NetSuiteError {
    return new NetSuiteError(400, code, detail);
  }

  static notFound(detail: string, code: NetSuiteErrorCode = 'NONEXISTENT_ID'): NetSuiteError {
    return new NetSuiteError(404, code, detail);
  }

  toBody(): NetSuiteErrorBody {
    return buildErrorBody(this.status, this.code, this.detail);
  }
}

export function buildErrorBody(status: number, code: NetSuiteErrorCode, detail: string): NetSuiteErrorBody {
  const info = STATUS_INFO[status] ?? STATUS_INFO[500]!;
  return {
    type: info.type,
    title: info.title,
    status,
    'o:errorDetails': [{ detail, 'o:errorCode': code }],
  };
}

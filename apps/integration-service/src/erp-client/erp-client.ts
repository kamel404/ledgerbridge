import { Inject, Injectable } from '@nestjs/common';
import { INTEGRATION_CONFIG, type IntegrationConfig } from '../config/integration.config.js';
import { RetryableError } from '../errors/integration-errors.js';
import { SECRETS_PROVIDER, type SecretsProvider } from '../secrets/secrets-provider.js';
import { erpErrorFromResponse } from './erp-errors.js';

export type ErpRecordType = 'customer' | 'vendor' | 'invoice' | 'customerPayment' | 'vendorBill';

/** A record as the ERP returns it: system fields plus the record's own fields. */
export interface ErpRecord {
  id: string;
  externalId?: string;
  [field: string]: unknown;
}

export interface SuiteQlPage<T = Record<string, unknown>> {
  items: T[];
  count: number;
  offset: number;
  totalResults: number;
  hasMore: boolean;
}

/** `fetch`, injectable so tests can fake the ERP without a server. */
export type FetchFn = typeof fetch;
export const HTTP_FETCH = Symbol('HTTP_FETCH');

const TOKEN_PATH = '/services/rest/auth/oauth2/v1/token';
const RECORD_PATH = '/services/rest/record/v1';
const SUITEQL_PATH = '/services/rest/query/v1/suiteql';

/** Refresh the token this long before it expires, so it can't expire mid-request. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface CachedToken {
  value: string;
  expiresAt: number;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Return undefined on 404 instead of throwing (for lookups). */
  allowNotFound?: boolean;
}

/**
 * All HTTP calls to the ERP go through here (SPEC §8.4).
 *
 * - Gets an OAuth token with client credentials and caches it until shortly
 *   before it expires. On a 401 it drops the token, fetches a new one and
 *   retries the call once.
 * - Every request has a timeout (10 s by default).
 * - Failures become RetryableError or PermanentError (see erp-errors.ts), so
 *   callers never look at HTTP status codes.
 *
 * Writes always use PUT /{type}/eid:{externalId} (upsert): running the same
 * event twice leaves one record (SPEC §8.3, record-level idempotency).
 */
@Injectable()
export class ErpClient {
  private token?: CachedToken;
  /** In-flight token request, shared by concurrent callers. */
  private tokenRequest?: Promise<string>;

  constructor(
    @Inject(INTEGRATION_CONFIG) private readonly config: IntegrationConfig,
    @Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider,
    @Inject(HTTP_FETCH) private readonly fetchFn: FetchFn,
  ) {}

  /** Creates or updates the record with this external ID. Returns its internal ID. */
  async upsert(type: ErpRecordType, externalId: string, body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await this.request('PUT', recordPath(type, externalId), { body });
    const id = internalIdFromLocation(res!.headers.get('location'));
    if (!id) {
      throw new RetryableError('ERP_BAD_RESPONSE', `ERP upsert of ${type} ${externalId} returned no Location header`);
    }
    return { id };
  }

  /** Reads a record by external ID, or undefined if it doesn't exist. */
  async getByExternalId(type: ErpRecordType, externalId: string): Promise<ErpRecord | undefined> {
    const res = await this.request('GET', recordPath(type, externalId), { allowNotFound: true });
    return res ? ((await res.json()) as ErpRecord) : undefined;
  }

  /** Runs a SuiteQL query (one page). */
  async suiteql<T = Record<string, unknown>>(
    query: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<SuiteQlPage<T>> {
    const params = new URLSearchParams();
    if (page.limit !== undefined) params.set('limit', String(page.limit));
    if (page.offset !== undefined) params.set('offset', String(page.offset));
    const qs = params.size ? `?${params}` : '';
    const res = await this.request('POST', `${SUITEQL_PATH}${qs}`, {
      body: { q: query },
      headers: { Prefer: 'transient' },
    });
    return (await res!.json()) as SuiteQlPage<T>;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async request(method: string, path: string, options: RequestOptions = {}): Promise<Response | undefined> {
    let res = await this.authorizedSend(method, path, options);
    if (res.status === 401) {
      // The token may have expired early or been revoked: get a fresh one, try once more.
      this.token = undefined;
      res = await this.authorizedSend(method, path, options);
    }
    if (res.status === 404 && options.allowNotFound) return undefined;
    if (!res.ok) {
      throw erpErrorFromResponse(res.status, await readBody(res), res.headers.get('retry-after'));
    }
    return res;
  }

  private async authorizedSend(method: string, path: string, options: RequestOptions): Promise<Response> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...options.headers };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    return this.send(`${method} ${path}`, `${this.config.erpBaseUrl}${path}`, { method, headers, body });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.token.value;
    }
    this.tokenRequest ??= this.fetchToken().finally(() => (this.tokenRequest = undefined));
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret } = await this.secrets.erpCredentials();
    const res = await this.send('token', `${this.config.erpBaseUrl}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!res.ok) {
      throw erpErrorFromResponse(res.status, await readBody(res), res.headers.get('retry-after'));
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') {
      throw new RetryableError('ERP_BAD_RESPONSE', 'ERP token response has no access_token');
    }
    const expiresInSeconds = typeof body.expires_in === 'number' ? body.expires_in : 300;
    this.token = { value: body.access_token, expiresAt: Date.now() + expiresInSeconds * 1000 };
    return this.token.value;
  }

  /** fetch with a timeout. Network problems and timeouts are retryable. */
  private async send(label: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.config.erpTimeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new RetryableError('ERP_TIMEOUT', `ERP request ${label} timed out after ${this.config.erpTimeoutMs} ms`, {
          cause: err,
        });
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new RetryableError('ERP_UNREACHABLE', `ERP request ${label} failed: ${reason}`, { cause: err });
    }
  }
}

function recordPath(type: ErpRecordType, externalId: string): string {
  return `${RECORD_PATH}/${type}/eid:${encodeURIComponent(externalId)}`;
}

/** ".../record/v1/invoice/42" -> "42" */
export function internalIdFromLocation(location: string | null): string | undefined {
  return location?.match(/\/(\d+)\/?$/)?.[1];
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

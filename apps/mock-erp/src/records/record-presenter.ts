import type { Request } from 'express';
import type { StoredRecord } from './record-store.js';

export const RECORD_API_BASE = '/services/rest/record/v1';

/** "https://host" as the client sees it (honours X-Forwarded-Proto behind API Gateway). */
export function baseUrl(req: Request): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0] ?? req.protocol;
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

export function recordUrl(req: Request, record: Pick<StoredRecord, 'type' | 'id'>): string {
  return `${baseUrl(req)}${RECORD_API_BASE}/${record.type}/${record.id}`;
}

/** A record as the REST API returns it: system fields, client fields, computed fields. */
export function toResource(req: Request, record: StoredRecord): Record<string, unknown> {
  return {
    links: [{ rel: 'self', href: recordUrl(req, record) }],
    id: record.id,
    ...(record.externalId && { externalId: record.externalId }),
    ...record.fields,
    ...record.computed,
    createdDate: record.createdDate,
    lastModifiedDate: record.lastModifiedDate,
  };
}

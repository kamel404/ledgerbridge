import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Flow, Source, SyncStatus } from '@ledgerbridge/shared';
import type { ErrorSummary } from '../errors/integration-errors.js';
import { SYNC_LOG_REPOSITORY, type SyncLogRepository, type SyncRecord } from './sync-record.js';

const TTL_DAYS = 90;

export interface NewEvent {
  eventId: string;
  source: Source;
  flow: Flow;
  eventType: string;
  businessKey: string;
  payload: unknown;
}

export interface RejectedEvent {
  /** The event's own ID if the body had one. */
  eventId?: string;
  source: Source;
  flow: Flow;
  eventType?: string;
  payload: unknown;
  error: ErrorSummary;
}

/**
 * Writes the sync log. Every status change goes through `transition`, which
 * also stamps updatedAt and appends to history.
 */
@Injectable()
export class SyncLogService {
  constructor(@Inject(SYNC_LOG_REPOSITORY) private readonly repo: SyncLogRepository) {}

  get(eventId: string): Promise<SyncRecord | undefined> {
    return this.repo.get(eventId);
  }

  /** RECEIVED. Returns false if this event ID was seen before (dedup). */
  received(event: NewEvent): Promise<boolean> {
    return this.repo.create(this.newRecord(event.eventId, 'RECEIVED', event));
  }

  /**
   * REJECTED: invalid payload, kept so it shows on the dashboard. Never
   * overwrites a real record: if the ID is taken, the rejection gets its own key.
   * Returns the key used.
   */
  async rejected(event: RejectedEvent): Promise<string> {
    const baseId = event.eventId ?? `rejected:${randomUUID()}`;
    const record = this.newRecord(baseId, 'REJECTED', event);
    record.lastError = event.error;
    record.history[0]!.note = event.error.code;
    if (await this.repo.create(record)) return baseId;

    const altId = `${baseId}:rejected:${randomUUID()}`;
    await this.repo.create({ ...record, eventId: altId });
    return altId;
  }

  /** Moves a record to a new status. Throws if the record doesn't exist. */
  async transition(
    eventId: string,
    status: SyncStatus,
    changes: Partial<Pick<SyncRecord, 'attempts' | 'erpRecordType' | 'erpRecordId' | 'lastError' | 'completedAt'>> = {},
    note?: string,
  ): Promise<SyncRecord> {
    const record = await this.repo.get(eventId);
    if (!record) throw new Error(`Sync record ${eventId} not found`);
    const now = new Date().toISOString();
    const updated: SyncRecord = {
      ...record,
      ...changes,
      status,
      updatedAt: now,
      history: [...record.history, { status, at: now, ...(note && { note }) }],
    };
    await this.repo.put(updated);
    return updated;
  }

  private newRecord(
    eventId: string,
    status: SyncStatus,
    e: { source: Source; flow: Flow; eventType?: string; businessKey?: string; payload: unknown },
  ): SyncRecord {
    const now = new Date();
    const iso = now.toISOString();
    return {
      eventId,
      source: e.source,
      flow: e.flow,
      ...(e.eventType && { eventType: e.eventType }),
      ...(e.businessKey && { businessKey: e.businessKey }),
      status,
      attempts: 0,
      payload: e.payload,
      receivedAt: iso,
      updatedAt: iso,
      ttl: Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 3600,
      history: [{ status, at: iso }],
    };
  }
}

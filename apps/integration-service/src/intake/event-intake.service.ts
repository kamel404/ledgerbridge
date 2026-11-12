import { Inject, Injectable } from '@nestjs/common';
import type { Flow, LedgerEvent, Source } from '@ledgerbridge/shared';
import { businessKeyOf } from '../flows/flow-handler.js';
import { EVENT_DISPATCHER, type EventDispatcher } from '../ingest/event-dispatcher.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';

export interface IntakeEvent {
  event: LedgerEvent;
  source: Source;
  flow: Flow;
}

/**
 * The one way a valid event enters LedgerBridge, whatever it came from
 * (webhook, CSV row): dedup on the event ID, RECEIVED record, then dispatch
 * (SQS on AWS, inline locally). SPEC §8.1 steps 4-5.
 *
 * A repeated ID is normally ignored. One exception: a record still RECEIVED
 * after STUCK_AFTER_MS may never have reached the queue (the Lambda crashed
 * between writing the record and SendMessage). The source retrying is our
 * chance to fix that, so the stored event is dispatched again. That's safe:
 * the worker skips events already SUCCEEDED and every ERP write is an upsert.
 * Younger RECEIVED records are just waiting for the worker; re-sending those
 * would only add extra queue messages.
 */
export const STUCK_AFTER_MS = 2 * 60_000;

@Injectable()
export class EventIntakeService {
  constructor(
    private readonly syncLog: SyncLogService,
    @Inject(EVENT_DISPATCHER) private readonly dispatcher: EventDispatcher,
  ) {}

  /** 'accepted' for a new event, 'duplicate' for an ID seen before. */
  async accept({ event, source, flow }: IntakeEvent): Promise<'accepted' | 'duplicate'> {
    const isNew = await this.syncLog.received({
      eventId: event.id,
      source,
      flow,
      eventType: event.type,
      businessKey: businessKeyOf(event),
      payload: event,
    });
    if (isNew) {
      await this.dispatcher.dispatch(event.id, event);
      return 'accepted';
    }

    const existing = await this.syncLog.get(event.id);
    if (existing?.status === 'RECEIVED' && Date.now() - Date.parse(existing.receivedAt) > STUCK_AFTER_MS) {
      // Re-send what we stored, not the new body: the record is the source of truth.
      await this.dispatcher.dispatch(event.id, existing.payload as LedgerEvent);
    }
    return 'duplicate';
  }
}

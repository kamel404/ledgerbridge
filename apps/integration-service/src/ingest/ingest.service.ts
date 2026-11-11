import { Inject, Injectable } from '@nestjs/common';
import { EVENT_FLOW, parseEvent, type Flow, type SyncStatus } from '@ledgerbridge/shared';
import { businessKeyOf } from '../flows/flow-handler.js';
import type { WebhookSource } from '../secrets/secrets-provider.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import { EVENT_DISPATCHER, type EventDispatcher } from './event-dispatcher.js';

/** Which flow each webhook source feeds. Also the flow of a body we can't parse (PLAN gap 3). */
const SOURCE_FLOW: Record<WebhookSource, Flow> = {
  billing: 'O2C',
  procurement: 'P2P',
};

export type IngestResult =
  | { httpStatus: 202; body: { syncId: string; status?: SyncStatus } }
  | { httpStatus: 200; body: { syncId: string; duplicate: true } }
  | { httpStatus: 400; body: { syncId: string; error: string; message: string } };

/**
 * What happens to a webhook once its signature checks out (SPEC §8.1):
 *
 *   not JSON / fails schema / wrong source -> REJECTED record, 400
 *   event ID seen before                   -> 200, nothing else
 *   otherwise                              -> RECEIVED record, dispatch, 202 { syncId }
 */
@Injectable()
export class IngestService {
  constructor(
    private readonly syncLog: SyncLogService,
    @Inject(EVENT_DISPATCHER) private readonly dispatcher: EventDispatcher,
  ) {}

  async ingest(source: WebhookSource, rawBody: Buffer): Promise<IngestResult> {
    const flow = SOURCE_FLOW[source];
    const text = rawBody.toString('utf8');

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.reject(source, flow, text, 'INVALID_JSON', 'Body is not valid JSON');
    }

    const parsed = parseEvent(json);
    if (!parsed.success) return this.reject(source, flow, json, 'INVALID_PAYLOAD', parsed.error);
    const event = parsed.event;

    if (EVENT_FLOW[event.type] !== flow) {
      return this.reject(
        source,
        flow,
        json,
        'WRONG_SOURCE',
        `Events of type ${event.type} are not accepted on /webhooks/${source}`,
      );
    }

    const isNew = await this.syncLog.received({
      eventId: event.id,
      source,
      flow,
      eventType: event.type,
      businessKey: businessKeyOf(event),
      payload: event,
    });
    if (!isNew) return { httpStatus: 200, body: { syncId: event.id, duplicate: true } };

    await this.dispatcher.dispatch(event.id, event);
    // With the inline dispatcher the event is already processed; report where it ended.
    const record = await this.syncLog.get(event.id);
    return { httpStatus: 202, body: { syncId: event.id, ...(record && { status: record.status }) } };
  }

  private async reject(
    source: WebhookSource,
    flow: Flow,
    payload: unknown,
    code: string,
    message: string,
  ): Promise<IngestResult> {
    const body = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const syncId = await this.syncLog.rejected({
      eventId: typeof body.id === 'string' && body.id.trim() ? body.id : undefined,
      eventType: typeof body.type === 'string' ? body.type : undefined,
      source,
      flow,
      payload,
      error: { code, message, class: 'permanent' },
    });
    return { httpStatus: 400, body: { syncId, error: code, message } };
  }
}

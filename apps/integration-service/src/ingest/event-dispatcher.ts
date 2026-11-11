import { Injectable } from '@nestjs/common';
import type { LedgerEvent } from '@ledgerbridge/shared';
import { SyncWorker } from '../worker/sync-worker.js';

/**
 * Hands an accepted event to whoever processes it. The ingest code only knows
 * this interface:
 * - Phase 2 (now): InlineDispatcher runs the worker in the same request.
 * - Phase 3+: an SQS dispatcher sends the event to the queue instead, and the
 *   webhook returns before any ERP call (SPEC §8.1: no ERP calls in ingest).
 */
export interface EventDispatcher {
  dispatch(eventId: string, event: LedgerEvent): Promise<void>;
}

export const EVENT_DISPATCHER = Symbol('EVENT_DISPATCHER');

/** Local stand-in for the queue: processes the event right away. */
@Injectable()
export class InlineDispatcher implements EventDispatcher {
  constructor(private readonly worker: SyncWorker) {}

  async dispatch(eventId: string, event: LedgerEvent): Promise<void> {
    await this.worker.process(eventId, event);
  }
}

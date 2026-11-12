import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_FLOW, type LedgerEvent, type SyncStatus } from '@ledgerbridge/shared';
import { classifyError, RetryableError, type ErrorSummary } from '../errors/integration-errors.js';
import { FlowRegistry } from '../flows/flow-registry.js';
import { addLogContext } from '../observability/log-context.js';
import { SYNC_METRICS, type SyncMetrics } from '../observability/sync-metrics.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';

export interface WorkOutcome {
  status: Extract<SyncStatus, 'SUCCEEDED' | 'RETRYING' | 'FAILED'>;
  /** True when the event had already succeeded and nothing was done. */
  skipped?: boolean;
  error?: ErrorSummary;
  /** Set for ERP 429s. Phase 4 delays the SQS message by this much. */
  retryAfterSeconds?: number;
}

/**
 * Processes one event and records the outcome in the sync log:
 *
 *   already SUCCEEDED -> skip (event-level idempotency, SPEC §8.3)
 *   PROCESSING (attempts + 1) -> processEvent ->
 *     ok         -> SUCCEEDED (+ ERP record, completedAt)
 *     retryable  -> RETRYING  (Phase 4: message returns to the queue)
 *     permanent  -> FAILED    (Phase 4: message deleted, no retry)
 *
 * Phase 2 calls this straight from the webhook. Phase 4 calls it per SQS message.
 */
@Injectable()
export class SyncWorker {
  private readonly logger = new Logger(SyncWorker.name);

  constructor(
    private readonly flows: FlowRegistry,
    private readonly syncLog: SyncLogService,
    @Inject(SYNC_METRICS) private readonly metrics: SyncMetrics,
  ) {}

  async process(eventId: string, event: LedgerEvent): Promise<WorkOutcome> {
    const record = await this.syncLog.get(eventId);
    if (record?.status === 'SUCCEEDED') return { status: 'SUCCEEDED', skipped: true };

    const attempt = (record?.attempts ?? 0) + 1;
    addLogContext({ attempt });
    await this.syncLog.transition(eventId, 'PROCESSING', { attempts: attempt });

    const flow = EVENT_FLOW[event.type];
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const result = await this.flows.processEvent(event);
      this.metrics.attempt(flow, 'SUCCEEDED', elapsed());
      await this.syncLog.transition(eventId, 'SUCCEEDED', {
        erpRecordType: result.erpRecordType,
        erpRecordId: result.erpRecordId,
        completedAt: new Date().toISOString(),
      });
      return { status: 'SUCCEEDED' };
    } catch (err) {
      const error = classifyError(err);
      const status = error.class === 'retryable' ? 'RETRYING' : 'FAILED';
      this.metrics.attempt(flow, status, elapsed());
      if (error.code === 'UNEXPECTED_ERROR') this.logger.error(`Unexpected error on ${eventId}`, err);
      await this.syncLog.transition(eventId, status, { lastError: error }, error.code);
      return {
        status,
        error,
        ...(err instanceof RetryableError && err.retryAfterSeconds && { retryAfterSeconds: err.retryAfterSeconds }),
      };
    }
  }
}

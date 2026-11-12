import { Logger, Module } from '@nestjs/common';
import type { SyncStatus } from '@ledgerbridge/shared';
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { ConfigModule } from '../config/config.module.js';
import { withLogContext } from '../observability/log-context.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import type { SyncMetrics } from '../observability/sync-metrics.js';
import { SyncLogModule } from '../sync-log/sync-log.module.js';
import type { SyncLogService } from '../sync-log/sync-log.service.js';

/** Statuses a dead message must not overwrite: the event already reached an end. */
const FINAL: ReadonlySet<SyncStatus> = new Set(['SUCCEEDED', 'FAILED', 'DEAD', 'REJECTED']);

/**
 * Runs for every message that lands in the DLQ (it failed 4 receives in a
 * row) and marks its sync record DEAD (SPEC §8.2), so the dashboard shows it.
 *
 * The Lambda trigger deletes the message from the DLQ afterwards. Nothing is
 * lost: the sync record keeps the full event, and replay (Phase 7) re-sends
 * it from there. Because the DLQ empties itself, the Phase 6 alarm watches
 * messages *arriving* in the DLQ, not messages sitting in it.
 *
 * A record that's already final is left alone: another copy of the same
 * event may have succeeded meanwhile (SQS can deliver a message twice).
 */
export class DeadLetterHandler {
  private readonly logger = new Logger(DeadLetterHandler.name);

  constructor(
    private readonly syncLog: Pick<SyncLogService, 'get' | 'transition'>,
    private readonly metrics: Pick<SyncMetrics, 'dead'>,
  ) {}

  async handle(records: SQSRecord[]): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of records) {
      try {
        await this.markDead(record);
      } catch (err) {
        // e.g. DynamoDB unavailable: report it, so the message stays and is tried again.
        this.logger.error(`Could not mark message ${record.messageId} DEAD`, err);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  private async markDead(record: SQSRecord): Promise<void> {
    const eventId = readEventId(record.body);
    if (!eventId) {
      // Nothing to mark. Log the ID and size only: the body may contain customer data.
      this.logger.error(`Dead message ${record.messageId} has no eventId (${record.body.length} bytes), dropped`);
      return;
    }
    await withLogContext({ eventId }, async () => {
      const current = await this.syncLog.get(eventId);
      if (!current) {
        this.logger.warn('Dead message, but there is no sync record');
        return;
      }
      await withLogContext({ flow: current.flow, eventType: current.eventType, attempt: current.attempts }, async () => {
        if (FINAL.has(current.status)) {
          this.logger.log(`Already ${current.status}, not marking it DEAD`);
          return;
        }
        await this.syncLog.transition(eventId, 'DEAD', {}, `DLQ after ${current.attempts} attempt(s)`);
        this.metrics.dead(current.flow);
        this.logger.warn(`DEAD after ${current.attempts} attempt(s): ${current.lastError?.code ?? 'no error recorded'}`);
      });
    });
  }
}

function readEventId(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { eventId?: unknown };
    return typeof json?.eventId === 'string' && json.eventId ? json.eventId : undefined;
  } catch {
    return undefined;
  }
}

/** Root module of the DLQ Lambda: config, the sync log and metrics. */
@Module({ imports: [ConfigModule, ObservabilityModule, SyncLogModule] })
export class DlqAppModule {}

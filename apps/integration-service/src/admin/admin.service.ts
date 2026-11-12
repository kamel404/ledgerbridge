import { Inject, Injectable, Logger } from '@nestjs/common';
import { Flow, SyncStatus, type LedgerEvent } from '@ledgerbridge/shared';
import { EVENT_DISPATCHER, type EventDispatcher } from '../ingest/event-dispatcher.js';
import { withLogContext } from '../observability/log-context.js';
import { SyncLogService } from '../sync-log/sync-log.service.js';
import type { ListPage, ListQuery } from '../sync-log/sync-list.js';
import type { SyncRecord } from '../sync-log/sync-record.js';
import type { ReconciliationReport } from '../reconciliation/reconciliation-report.js';
import { RECONCILIATION_STORE, type ReconciliationStore } from '../reconciliation/reconciliation-store.js';
import { QUEUE_STATS, type QueueStats, type QueueStatsReader } from './queue-stats.js';

/** Only these can be replayed (SPEC §8.6). REJECTED has no valid event to send. */
export const REPLAYABLE: readonly SyncStatus[] = ['FAILED', 'DEAD'];

export interface Stats {
  /** The 24-hour window the counts cover. */
  since: string;
  until: string;
  /** Records per status whose last change is in the window. */
  byStatus: Record<SyncStatus, number>;
  byFlow: Record<Flow, Record<SyncStatus, number>>;
  /** Missing when there are no queues (local run). */
  queues?: QueueStats;
  /** The last reconciliation run, or null if none has run yet. */
  reconciliation: ReconciliationReport | null;
}

export type ReplayResult =
  | { outcome: 'queued'; record: SyncRecord }
  | { outcome: 'not-found' }
  | { outcome: 'not-replayable'; status?: SyncStatus };

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly syncLog: SyncLogService,
    @Inject(EVENT_DISPATCHER) private readonly dispatcher: EventDispatcher,
    @Inject(QUEUE_STATS) private readonly queues: QueueStatsReader,
    @Inject(RECONCILIATION_STORE) private readonly reconciliation: ReconciliationStore,
  ) {}

  list(query: ListQuery): Promise<ListPage> {
    return this.syncLog.list(query);
  }

  get(eventId: string): Promise<SyncRecord | undefined> {
    return this.syncLog.get(eventId);
  }

  async stats(now = new Date()): Promise<Stats> {
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const [counts, queues, reconciliation] = await Promise.all([
      this.syncLog.countSince(since),
      this.queues.read(),
      this.reconciliation.latest(),
    ]);
    const byStatus = Object.fromEntries(
      SyncStatus.options.map((s) => [s, Flow.options.reduce((n, f) => n + counts[s][f], 0)]),
    ) as Record<SyncStatus, number>;
    const byFlow = Object.fromEntries(
      Flow.options.map((f) => [f, Object.fromEntries(SyncStatus.options.map((s) => [s, counts[s][f]]))]),
    ) as Record<Flow, Record<SyncStatus, number>>;
    return { since, until: now.toISOString(), byStatus, byFlow, ...(queues && { queues }), reconciliation: reconciliation ?? null };
  }

  /**
   * Replay (SPEC §8.6, PLAN gap 1): reset the record to RECEIVED with
   * attempts 0, then send the stored event straight to the queue. It skips
   * the ingest dedup on purpose: the event ID exists, that's the point.
   *
   * The status change is conditional, so two clicks can't queue it twice:
   * the second finds RECEIVED and is refused.
   */
  async replay(eventId: string): Promise<ReplayResult> {
    return withLogContext({ eventId }, async () => {
      const result = await this.syncLog.transitionFrom(
        eventId,
        REPLAYABLE,
        'RECEIVED',
        { attempts: 0, lastError: undefined, completedAt: undefined },
        'replayed',
      );
      if (result === 'missing') return { outcome: 'not-found' as const };
      if (result === 'refused') {
        const current = await this.syncLog.get(eventId);
        return { outcome: 'not-replayable' as const, ...(current && { status: current.status }) };
      }

      try {
        await this.dispatcher.dispatch(eventId, result.payload as LedgerEvent);
      } catch (err) {
        // Queueing failed: put the record back so it can be replayed again.
        const previous = result.history.at(-2)?.status ?? 'FAILED';
        await this.syncLog.transition(eventId, previous, {}, 'replay could not be queued');
        throw err;
      }
      this.logger.log('Replayed: sent to the queue again');
      return { outcome: 'queued' as const, record: result };
    });
  }
}

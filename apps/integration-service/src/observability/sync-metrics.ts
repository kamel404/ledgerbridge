import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { Flow } from '@ledgerbridge/shared';

/** CloudWatch namespace of all LedgerBridge metrics (SPEC §11). */
export const METRICS_NAMESPACE = 'LedgerBridge';

/** Names, so CDK alarms and the code can't drift apart (infra reads the same strings). */
export const METRIC = {
  succeeded: 'SyncSucceeded',
  failed: 'SyncFailed',
  retried: 'SyncRetried',
  dead: 'SyncDead',
  durationMs: 'SyncDurationMs',
  /** Per reconciliation run: records missing on one side (0 when both sides agree). No flow dimension. */
  reconciliationMismatches: 'ReconciliationMismatches',
} as const;

/**
 * Counts what happens to events, per flow. On Lambda these become CloudWatch
 * metrics; locally (and in tests) nothing is recorded.
 */
export interface SyncMetrics {
  /** One processing attempt ended. `durationMs` = time spent in the flow handler. */
  attempt(flow: Flow, outcome: 'SUCCEEDED' | 'FAILED' | 'RETRYING', durationMs: number): void;
  /** An event was marked DEAD by the DLQ handler. */
  dead(flow: Flow): void;
  /** A reconciliation run ended with this many mismatches (also sent when 0). */
  reconciled(mismatches: number): void;
}

export const SYNC_METRICS = Symbol('SYNC_METRICS');

export class NoopSyncMetrics implements SyncMetrics {
  attempt(): void {}
  dead(): void {}
  reconciled(): void {}
}

/**
 * Powertools Metrics in "single metric" mode: each data point is written at
 * once as one Embedded Metric Format log line, which CloudWatch turns into a
 * metric. No API calls, nothing to flush at the end of the invocation, and
 * each line carries its own `flow` dimension (one batch can mix flows).
 *
 * Powertools also adds a `service` dimension (POWERTOOLS_SERVICE_NAME);
 * alarms and the dashboard use both dimensions.
 */
export class PowertoolsSyncMetrics implements SyncMetrics {
  private readonly metrics = new Metrics({ namespace: METRICS_NAMESPACE });

  attempt(flow: Flow, outcome: 'SUCCEEDED' | 'FAILED' | 'RETRYING', durationMs: number): void {
    const name = outcome === 'SUCCEEDED' ? METRIC.succeeded : outcome === 'FAILED' ? METRIC.failed : METRIC.retried;
    this.emit(flow, name, MetricUnit.Count, 1);
    this.emit(flow, METRIC.durationMs, MetricUnit.Milliseconds, durationMs);
  }

  dead(flow: Flow): void {
    this.emit(flow, METRIC.dead, MetricUnit.Count, 1);
  }

  reconciled(mismatches: number): void {
    // Only the `service` dimension: reconciliation covers both flows at once.
    this.metrics.singleMetric().addMetric(METRIC.reconciliationMismatches, MetricUnit.Count, mismatches);
  }

  private emit(flow: Flow, name: string, unit: (typeof MetricUnit)[keyof typeof MetricUnit], value: number) {
    const single = this.metrics.singleMetric();
    single.addDimension('flow', flow);
    single.addMetric(name, unit, value); // written immediately
  }
}

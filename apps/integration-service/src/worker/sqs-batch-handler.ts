import { ChangeMessageVisibilityCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { parseEvent, type LedgerEvent } from '@ledgerbridge/shared';
import type { SQSBatchResponse, SQSRecord } from 'aws-lambda';
import type { SyncMessage } from '../ingest/sqs-dispatcher.js';
import type { SyncWorker, WorkOutcome } from './sync-worker.js';

/**
 * How long a retryable message waits before SQS hands it out again.
 *
 * Without this it would wait the queue's full visibility timeout (3 minutes).
 * A payment that arrived before its invoice would then take minutes to sync.
 * Instead: the ERP's Retry-After if it sent one (SPEC §8.2), otherwise
 * 10 s, 30 s, 90 s for receives 1, 2, 3. The 4th failed receive sends the
 * message to the DLQ (redrive policy in infra).
 */
const BACKOFF_SECONDS = [10, 30, 90];
/** Cap so a huge Retry-After can't park a message for hours. */
const MAX_DELAY_SECONDS = 900;

export function retryDelaySeconds(outcome: Pick<WorkOutcome, 'retryAfterSeconds'>, receiveCount: number): number {
  if (outcome.retryAfterSeconds && outcome.retryAfterSeconds > 0) {
    return Math.min(Math.ceil(outcome.retryAfterSeconds), MAX_DELAY_SECONDS);
  }
  return BACKOFF_SECONDS[Math.max(0, receiveCount - 1)] ?? BACKOFF_SECONDS.at(-1)!;
}

/** Sets when a received message becomes visible again. */
export type ChangeVisibility = (record: SQSRecord, seconds: number) => Promise<void>;

/** arn:aws:sqs:<region>:<account>:<name>  ->  https://sqs.<region>.amazonaws.com/<account>/<name> */
export function queueUrlFromArn(arn: string): string {
  const [, , , region, account, name] = arn.split(':');
  if (!region || !account || !name) throw new Error(`Not an SQS queue ARN: ${arn}`);
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

/** ChangeVisibility backed by the real SQS API. */
export function sqsChangeVisibility(sqs: SQSClient): ChangeVisibility {
  return async (record, seconds) => {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrlFromArn(record.eventSourceARN),
        ReceiptHandle: record.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  };
}

/**
 * The worker Lambda's logic for one SQS batch (SPEC §8.2), kept apart from
 * the Lambda entry point so it can be tested without AWS.
 *
 * Per message, depending on what SyncWorker returns:
 *   SUCCEEDED (or already done) -> not reported   -> Lambda deletes it
 *   FAILED (permanent)          -> not reported   -> deleted, retrying won't help
 *   RETRYING                    -> reported failed -> back on the queue after retryDelaySeconds
 *   unreadable message / crash  -> reported failed -> retried, then the DLQ
 *
 * "Reported" means listed in batchItemFailures (ReportBatchItemFailures), so
 * only those messages return to the queue, not the whole batch.
 *
 * Messages are processed one after the other: it keeps the ERP request rate
 * low, and two copies of the same event in one batch can't race each other.
 */
export class SqsBatchHandler {
  private readonly logger = new Logger(SqsBatchHandler.name);

  constructor(
    private readonly worker: Pick<SyncWorker, 'process'>,
    private readonly changeVisibility: ChangeVisibility,
  ) {}

  async handle(records: SQSRecord[]): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of records) {
      if (!(await this.handleOne(record))) batchItemFailures.push({ itemIdentifier: record.messageId });
    }
    return { batchItemFailures };
  }

  /** Returns true when the message can be deleted. */
  private async handleOne(record: SQSRecord): Promise<boolean> {
    const receiveCount = Number(record.attributes.ApproximateReceiveCount) || 1;

    const message = readMessage(record.body);
    if (!message) {
      // Will never parse. Reporting it lets the redrive policy move it to the
      // DLQ, where a human can look at it, instead of dropping it silently.
      this.logger.error(`Unreadable message ${record.messageId}, leaving it for the DLQ`);
      return false;
    }

    let outcome: WorkOutcome;
    try {
      outcome = await this.worker.process(message.eventId, message.event);
    } catch (err) {
      // e.g. DynamoDB unavailable: the sync log couldn't even be updated.
      this.logger.error(`Worker crashed on ${message.eventId} (receive ${receiveCount})`, err);
      return false;
    }

    this.logger.log(
      `${message.eventId} ${message.event.type}: ${outcome.status}` +
        (outcome.skipped ? ' (already done, skipped)' : '') +
        (outcome.error ? ` ${outcome.error.code}` : '') +
        ` (receive ${receiveCount})`,
    );
    if (outcome.status !== 'RETRYING') return true;

    const delay = retryDelaySeconds(outcome, receiveCount);
    try {
      await this.changeVisibility(record, delay);
    } catch (err) {
      // Not fatal: the message still comes back, just after the queue's default timeout.
      this.logger.warn(`Could not set a ${delay}s retry delay on ${message.eventId}: ${String(err)}`);
    }
    return false;
  }
}

/** The body SqsDispatcher sends: {"eventId", "event"}. Undefined if it isn't that. */
function readMessage(body: string): { eventId: string; event: LedgerEvent } | undefined {
  let json: Partial<SyncMessage>;
  try {
    json = JSON.parse(body) as Partial<SyncMessage>;
  } catch {
    return undefined;
  }
  if (typeof json?.eventId !== 'string' || !json.eventId) return undefined;
  const parsed = parseEvent(json.event);
  return parsed.success ? { eventId: json.eventId, event: parsed.event } : undefined;
}

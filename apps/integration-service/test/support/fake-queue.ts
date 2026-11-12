import type { LedgerEvent } from '@ledgerbridge/shared';
import type { SQSRecord } from 'aws-lambda';
import type { EventDispatcher } from '../../src/ingest/event-dispatcher.js';
import type { SyncMessage } from '../../src/ingest/sqs-dispatcher.js';
import type { SqsBatchHandler } from '../../src/worker/sqs-batch-handler.js';

const MAX_RECEIVE_COUNT = 4; // same as the SyncQueue redrive policy in infra

/**
 * A stand-in for SQS with the parts that matter here: batches of 5, a receive
 * count per message, visibility delays, and a DLQ after 4 receives. Time is
 * virtual, so a 90 s backoff takes no real time.
 */
export class FakeQueue implements EventDispatcher {
  private seq = 0;
  private now = 0;
  private readonly messages = new Map<string, { body: string; receiveCount: number; visibleAt: number }>();
  readonly dlq: string[] = [];
  readonly delays: number[] = [];

  async dispatch(eventId: string, event: LedgerEvent): Promise<void> {
    this.send({ eventId, event });
  }

  /** Puts a message on the queue directly, e.g. to simulate SQS delivering a duplicate. */
  send(message: SyncMessage): void {
    this.messages.set(`msg-${++this.seq}`, { body: JSON.stringify(message), receiveCount: 0, visibleAt: this.now });
  }

  get depth(): number {
    return this.messages.size;
  }

  /** Delivers batches to the handler until the queue is empty, jumping the clock forward as needed. */
  async drain(handler: SqsBatchHandler): Promise<void> {
    for (let round = 0; this.messages.size > 0; round++) {
      if (round > 50) throw new Error('queue did not drain');
      if (!(await this.deliverVisible(handler))) {
        this.now = Math.min(...[...this.messages.values()].map((m) => m.visibleAt));
      }
    }
  }

  /** One round: delivers the messages visible right now (no clock jump). False if none were. */
  async deliverVisible(handler: SqsBatchHandler): Promise<boolean> {
    const visible = [...this.messages].filter(([, m]) => m.visibleAt <= this.now);
    if (visible.length === 0) return false;
    const batch: SQSRecord[] = [];
    for (const [id, m] of visible.slice(0, 5)) {
      if (m.receiveCount >= MAX_RECEIVE_COUNT) {
        this.messages.delete(id); // redrive policy
        this.dlq.push(m.body);
        continue;
      }
      m.receiveCount++;
      m.visibleAt = this.now + 180; // the queue's default visibility timeout
      batch.push(this.toRecord(id, m.body, m.receiveCount));
    }
    if (batch.length > 0) {
      const { batchItemFailures } = await handler.handle(batch);
      const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier));
      for (const r of batch) if (!failed.has(r.messageId)) this.messages.delete(r.messageId);
    }
    return true;
  }

  /** What the handler's changeVisibility does to this queue. */
  changeVisibility = async (record: SQSRecord, seconds: number): Promise<void> => {
    this.delays.push(seconds);
    const m = this.messages.get(record.messageId);
    if (m) m.visibleAt = this.now + seconds;
  };

  private toRecord(id: string, body: string, receiveCount: number): SQSRecord {
    return {
      messageId: id,
      receiptHandle: id,
      body,
      attributes: { ApproximateReceiveCount: String(receiveCount) } as SQSRecord['attributes'],
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:eu-north-1:123456789012:SyncQueue',
      awsRegion: 'eu-north-1',
    };
  }
}

import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { LedgerEvent } from '@ledgerbridge/shared';
import type { EventDispatcher } from './event-dispatcher.js';

/** What goes on the queue. The worker (Phase 4) reads exactly this. */
export interface SyncMessage {
  eventId: string;
  event: LedgerEvent;
}

/**
 * On AWS: puts the event on the SQS queue and returns. The webhook answers
 * 202 right away; the worker Lambda does the ERP calls later (SPEC §8.1:
 * no ERP calls in ingest, target < 500 ms).
 */
export class SqsDispatcher implements EventDispatcher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async dispatch(eventId: string, event: LedgerEvent): Promise<void> {
    const message: SyncMessage = { eventId, event };
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: { eventType: { DataType: 'String', StringValue: event.type } },
      }),
    );
  }
}

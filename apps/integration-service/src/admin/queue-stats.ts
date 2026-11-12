import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

export interface QueueDepth {
  /** Waiting to be picked up. */
  waiting: number;
  /** Picked up and being processed, or waiting for a retry. */
  inFlight: number;
}

export interface QueueStats {
  queue: QueueDepth;
  dlq: QueueDepth;
}

/** Queue depths for the Overview page. Undefined where there are no queues (locally). */
export interface QueueStatsReader {
  read(): Promise<QueueStats | undefined>;
}

export const QUEUE_STATS = Symbol('QUEUE_STATS');

export class NoQueueStats implements QueueStatsReader {
  async read(): Promise<undefined> {
    return undefined;
  }
}

/** SQS GetQueueAttributes. The counts are approximate (SQS says so itself). */
export class SqsQueueStats implements QueueStatsReader {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
  ) {}

  async read(): Promise<QueueStats> {
    const [queue, dlq] = await Promise.all([this.depth(this.queueUrl), this.depth(this.dlqUrl)]);
    return { queue, dlq };
  }

  private async depth(url: string): Promise<QueueDepth> {
    const res = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return {
      waiting: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }
}

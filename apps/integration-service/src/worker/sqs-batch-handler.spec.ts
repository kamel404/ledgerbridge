import type { SQSRecord } from 'aws-lambda';
import { invoiceEvent } from '../test-support/events.js';
import { queueUrlFromArn, retryDelaySeconds, SqsBatchHandler } from './sqs-batch-handler.js';
import type { WorkOutcome } from './sync-worker.js';

const ARN = 'arn:aws:sqs:eu-north-1:123456789012:SyncQueue';

function record(id: string, body: unknown, receiveCount = 1): SQSRecord {
  return {
    messageId: id,
    receiptHandle: `rh-${id}`,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: { ApproximateReceiveCount: String(receiveCount) } as SQSRecord['attributes'],
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: ARN,
    awsRegion: 'eu-north-1',
  };
}

function message(eventId: string) {
  return { eventId, event: { ...invoiceEvent(), id: eventId } };
}

function setup(outcomes: Record<string, WorkOutcome | Error>) {
  const process = vi.fn(async (eventId: string) => {
    const o = outcomes[eventId];
    if (o instanceof Error) throw o;
    return o ?? { status: 'SUCCEEDED' as const };
  });
  const changeVisibility = vi.fn(async (_record: SQSRecord, _seconds: number) => undefined);
  return { handler: new SqsBatchHandler({ process }, changeVisibility), process, changeVisibility };
}

describe('SqsBatchHandler', () => {
  it('reports only the retryable messages as failed', async () => {
    const t = setup({
      ok: { status: 'SUCCEEDED' },
      retry: { status: 'RETRYING', error: { code: 'ERP_SERVICE_UNAVAILABLE', message: '', class: 'retryable' } },
      perm: { status: 'FAILED', error: { code: 'UNKNOWN_SKU', message: '', class: 'permanent' } },
      skip: { status: 'SUCCEEDED', skipped: true },
    });

    const res = await t.handler.handle([
      record('m1', message('ok')),
      record('m2', message('retry')),
      record('m3', message('perm')),
      record('m4', message('skip')),
    ]);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(t.process).toHaveBeenCalledTimes(4);
  });

  it('delays a retry by Retry-After on a 429', async () => {
    const t = setup({ e: { status: 'RETRYING', retryAfterSeconds: 30 } });
    await t.handler.handle([record('m1', message('e'))]);
    expect(t.changeVisibility).toHaveBeenCalledWith(expect.objectContaining({ receiptHandle: 'rh-m1' }), 30);
  });

  it('backs off 10 s, 30 s, 90 s without Retry-After', async () => {
    const t = setup({ e: { status: 'RETRYING' } });
    for (const n of [1, 2, 3]) await t.handler.handle([record(`m${n}`, message('e'), n)]);
    expect(t.changeVisibility.mock.calls.map((c) => c[1])).toEqual([10, 30, 90]);
  });

  it('does not touch visibility for messages that are done', async () => {
    const t = setup({ e: { status: 'FAILED' } });
    await t.handler.handle([record('m1', message('e'))]);
    expect(t.changeVisibility).not.toHaveBeenCalled();
  });

  it('still reports the failure if setting the delay fails', async () => {
    const t = setup({ e: { status: 'RETRYING' } });
    t.changeVisibility.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(t.handler.handle([record('m1', message('e'))])).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'm1' }],
    });
  });

  it('reports a crash (e.g. DynamoDB down) without failing the other messages', async () => {
    const t = setup({ boom: new Error('DynamoDB unavailable') });
    const res = await t.handler.handle([record('m1', message('boom')), record('m2', message('ok'))]);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['no eventId', { event: invoiceEvent() }],
    ['invalid event', { eventId: 'e', event: { type: 'invoice.created' } }],
  ])('leaves an unreadable message (%s) for the DLQ without calling the worker', async (_, body) => {
    const t = setup({});
    const res = await t.handler.handle([record('m1', body)]);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(t.process).not.toHaveBeenCalled();
  });
});

describe('retryDelaySeconds', () => {
  it('caps a huge Retry-After at 15 minutes', () => {
    expect(retryDelaySeconds({ retryAfterSeconds: 86_400 }, 1)).toBe(900);
  });
  it('keeps the last backoff step after the third receive', () => {
    expect(retryDelaySeconds({}, 7)).toBe(90);
  });
});

describe('queueUrlFromArn', () => {
  it('builds the queue URL', () => {
    expect(queueUrlFromArn(ARN)).toBe('https://sqs.eu-north-1.amazonaws.com/123456789012/SyncQueue');
  });
  it('rejects anything else', () => {
    expect(() => queueUrlFromArn('nope')).toThrow('Not an SQS queue ARN');
  });
});

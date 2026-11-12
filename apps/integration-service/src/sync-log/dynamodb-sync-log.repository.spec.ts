import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbSyncLogRepository } from './dynamodb-sync-log.repository.js';

interface QueryInput {
  IndexName?: string;
  KeyConditionExpression?: string;
  FilterExpression?: string;
  ProjectionExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ExclusiveStartKey?: Record<string, unknown>;
  ScanIndexForward?: boolean;
}

/**
 * A fake DynamoDB client: records each command's input and answers from
 * `respond`. It also enforces DynamoDB's rule that every #name and :value
 * declared must be used by an expression (and vice versa), which DynamoDB
 * only reports at runtime with a ValidationException.
 */
function fakeDb(respond: (input: QueryInput) => { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> }) {
  const inputs: QueryInput[] = [];
  const client = {
    send: vi.fn(async (cmd: { input: QueryInput }) => {
      const input = cmd.input;
      inputs.push(input);
      const expressions = [input.KeyConditionExpression, input.FilterExpression, input.ProjectionExpression, input.ConditionExpression]
        .filter(Boolean)
        .join(' ');
      for (const name of Object.keys(input.ExpressionAttributeNames ?? {})) {
        if (!expressions.includes(name)) throw new Error(`ValidationException: unused name ${name}`);
      }
      for (const value of Object.keys(input.ExpressionAttributeValues ?? {})) {
        if (!new RegExp(`${value}(?![A-Za-z0-9_])`).test(expressions)) throw new Error(`ValidationException: unused value ${value}`);
      }
      for (const used of expressions.match(/[#:][A-Za-z0-9_]+/g) ?? []) {
        const declared = used.startsWith('#') ? input.ExpressionAttributeNames : input.ExpressionAttributeValues;
        if (!declared || !(used in declared)) throw new Error(`ValidationException: undeclared ${used}`);
      }
      return respond(input);
    }),
  };
  return { db: client as unknown as Pick<DynamoDBDocumentClient, 'send'>, inputs };
}

const item = (eventId: string, status: string, updatedAt: string) => ({ eventId, status, updatedAt, flow: 'O2C' });

describe('DynamoDbSyncLogRepository', () => {
  it('lists one status newest first from the byStatus index, with valid expressions', async () => {
    const { db, inputs } = fakeDb(() => ({ Items: [item('b', 'DEAD', '2'), item('a', 'DEAD', '1')] }));
    const repo = new DynamoDbSyncLogRepository(undefined, 'SyncLog', db);

    const page = await repo.list({ status: 'DEAD', flow: 'O2C', q: 'inv', limit: 25 });

    expect(page.items.map((i) => i.eventId)).toEqual(['b', 'a']);
    expect(page.nextCursor).toBeUndefined();
    expect(inputs[0]).toMatchObject({ IndexName: 'byStatus', ScanIndexForward: false });
    expect(inputs[0]!.FilterExpression).toContain('contains(businessKey, :qUpper)');
    expect(inputs[0]!.ExpressionAttributeValues).toMatchObject({ ':s': 'DEAD', ':q': 'inv', ':qUpper': 'INV' });
  });

  it('continues from the cursor with the last shown item as ExclusiveStartKey', async () => {
    let call = 0;
    const { db, inputs } = fakeDb(() =>
      call++ === 0 ? { Items: [item('c', 'FAILED', '3'), item('b', 'FAILED', '2'), item('a', 'FAILED', '1')] } : { Items: [item('a', 'FAILED', '1')] },
    );
    const repo = new DynamoDbSyncLogRepository(undefined, 'SyncLog', db);

    const first = await repo.list({ status: 'FAILED', limit: 2 });
    expect(first.items.map((i) => i.eventId)).toEqual(['c', 'b']);
    const second = await repo.list({ status: 'FAILED', limit: 2, cursor: first.nextCursor! });

    expect(inputs.at(-1)!.ExclusiveStartKey).toEqual({ eventId: 'b', status: 'FAILED', updatedAt: '2' });
    expect(second.items.map((i) => i.eventId)).toEqual(['a']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('queries every status when no status filter is given', async () => {
    const { db, inputs } = fakeDb(() => ({ Items: [] }));
    await new DynamoDbSyncLogRepository(undefined, 'SyncLog', db).list({ limit: 25 });
    expect(new Set(inputs.map((i) => i.ExpressionAttributeValues![':s']))).toEqual(
      new Set(['RECEIVED', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'DEAD', 'REJECTED']),
    );
  });

  it('counts per status and flow with a key condition on updatedAt', async () => {
    const { db, inputs } = fakeDb((input) =>
      input.ExpressionAttributeValues![':s'] === 'DEAD' ? { Items: [{ flow: 'O2C' }, { flow: 'P2P' }, { flow: 'P2P' }] } : { Items: [] },
    );
    const counts = await new DynamoDbSyncLogRepository(undefined, 'SyncLog', db).countSince('2026-11-11T00:00:00Z');
    expect(counts.DEAD).toEqual({ O2C: 1, P2P: 2 });
    expect(inputs[0]!.KeyConditionExpression).toBe('#s = :s AND updatedAt >= :since');
  });

  it('listSince reads every page of one status from the index, only the fields reconciliation needs', async () => {
    const { db, inputs } = fakeDb((input) =>
      input.ExclusiveStartKey
        ? { Items: [item('b', 'SUCCEEDED', '2026-11-12T02:00:00Z')] }
        : { Items: [item('a', 'SUCCEEDED', '2026-11-12T01:00:00Z')], LastEvaluatedKey: { eventId: 'a' } },
    );
    const refs = await new DynamoDbSyncLogRepository(undefined, 'SyncLog', db).listSince('SUCCEEDED', '2026-11-12T00:00:00Z');
    expect(refs.map((r) => r.eventId)).toEqual(['a', 'b']);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      IndexName: 'byStatus',
      KeyConditionExpression: '#s = :s AND updatedAt >= :since',
      ExpressionAttributeValues: { ':s': 'SUCCEEDED', ':since': '2026-11-12T00:00:00Z' },
    });
    expect(inputs[0]!.ProjectionExpression).not.toContain('payload');
  });

  it('replaceIf is a conditional write on the status', async () => {
    const { db, inputs } = fakeDb(() => ({}));
    await new DynamoDbSyncLogRepository(undefined, 'SyncLog', db).replaceIf({ eventId: 'a' } as never, 'DEAD');
    expect(inputs[0]).toMatchObject({ ConditionExpression: '#s = :expected', ExpressionAttributeValues: { ':expected': 'DEAD' } });
  });
});

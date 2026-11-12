import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SyncStatus } from '@ledgerbridge/shared';
import {
  emptyCounts,
  listAcrossStatuses,
  type ListPage,
  type ListQuery,
  type StatusCounts,
  type StatusKey,
  type SyncSummary,
} from './sync-list.js';
import type { SyncLogRepository, SyncRecord, SyncRef } from './sync-record.js';

const BY_STATUS = 'byStatus';
/** List rows don't need the payload or history: smaller responses. */
const SUMMARY_FIELDS = [
  'eventId', 'source', 'flow', 'eventType', 'status', 'attempts', 'businessKey',
  'erpRecordType', 'erpRecordId', 'lastError', 'receivedAt', 'updatedAt', 'completedAt',
];
/** Per status, at most this many Query calls per page (when a filter skips many items). */
const MAX_QUERIES_PER_STATUS = 10;

/**
 * SyncLog table on DynamoDB (SPEC §8.5): pk = eventId, GSI byStatus
 * (pk = status, sk = updatedAt) for the dashboard, `ttl` for 90-day expiry.
 *
 * `create` is the ingest dedup (SPEC §8.1): a conditional put that only
 * succeeds if no item with this eventId exists. Two copies of the same webhook
 * racing each other: exactly one wins, the other gets `false`.
 *
 * Listing reads the byStatus index, which is updated a moment after each
 * write (eventually consistent). Fine for a dashboard.
 */
export class DynamoDbSyncLogRepository implements SyncLogRepository {
  private readonly db: Pick<DynamoDBDocumentClient, 'send'>;

  /** `db` is for tests (a fake document client); normally it's built from `client`. */
  constructor(
    client: DynamoDBClient | undefined,
    private readonly tableName: string,
    db?: Pick<DynamoDBDocumentClient, 'send'>,
  ) {
    this.db =
      db ??
      DynamoDBDocumentClient.from(client!, {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
      });
  }

  async create(record: SyncRecord): Promise<boolean> {
    return this.conditionalPut(record, 'attribute_not_exists(eventId)');
  }

  async get(eventId: string): Promise<SyncRecord | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { eventId }, ConsistentRead: true }),
    );
    return res.Item as SyncRecord | undefined;
  }

  async put(record: SyncRecord): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.tableName, Item: record }));
  }

  async replaceIf(record: SyncRecord, expectedStatus: SyncStatus): Promise<boolean> {
    return this.conditionalPut(record, '#s = :expected', { '#s': 'status' }, { ':expected': expectedStatus });
  }

  list(query: ListQuery): Promise<ListPage> {
    return listAcrossStatuses((status, startKey, need) => this.readStatus(status, startKey, need, query), query);
  }

  async countSince(sinceIso: string): Promise<StatusCounts> {
    const counts = emptyCounts();
    await Promise.all(
      SyncStatus.options.map(async (status) => {
        let startKey: Record<string, unknown> | undefined;
        do {
          const res = await this.db.send(
            new QueryCommand({
              TableName: this.tableName,
              IndexName: BY_STATUS,
              KeyConditionExpression: '#s = :s AND updatedAt >= :since',
              ExpressionAttributeNames: { '#s': 'status' },
              ExpressionAttributeValues: { ':s': status, ':since': sinceIso },
              ProjectionExpression: 'flow',
              ExclusiveStartKey: startKey,
            }),
          );
          for (const item of res.Items ?? []) {
            const flow = item.flow as keyof StatusCounts[SyncStatus];
            if (flow in counts[status]) counts[status][flow]++;
          }
          startKey = res.LastEvaluatedKey;
        } while (startKey);
      }),
    );
    return counts;
  }

  async listSince(status: SyncStatus, sinceIso: string): Promise<SyncRef[]> {
    const fields = ['eventId', 'flow', 'businessKey', 'erpRecordType', 'erpRecordId', 'updatedAt'];
    const refs: SyncRef[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: BY_STATUS,
          KeyConditionExpression: '#s = :s AND updatedAt >= :since',
          ExpressionAttributeNames: { '#s': 'status', ...Object.fromEntries(fields.map((f) => [`#f_${f}`, f])) },
          ExpressionAttributeValues: { ':s': status, ':since': sinceIso },
          ProjectionExpression: fields.map((f) => `#f_${f}`).join(', '),
          ExclusiveStartKey: startKey,
        }),
      );
      refs.push(...((res.Items ?? []) as SyncRef[]));
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return refs;
  }

  /** One status, newest first, filtered: up to `need` matches after `startKey`. */
  private async readStatus(status: SyncStatus, startKey: StatusKey | undefined, need: number, query: ListQuery) {
    const names: Record<string, string> = { '#s': 'status' };
    const values: Record<string, unknown> = { ':s': status };
    const filters: string[] = [];
    if (query.flow) {
      names['#flow'] = 'flow';
      values[':flow'] = query.flow;
      filters.push('#flow = :flow');
    }
    if (query.q?.trim()) {
      // contains() is case-sensitive, so also try upper case (business keys are like INV-1042).
      const q = query.q.trim();
      values[':q'] = q;
      values[':qUpper'] = q.toUpperCase();
      filters.push('(contains(businessKey, :q) OR contains(businessKey, :qUpper) OR eventId = :q)');
    }
    // (DynamoDB rejects unused attribute names, so only add what the expressions use.)

    const items: SyncSummary[] = [];
    let exclusiveStart: Record<string, unknown> | undefined = startKey && { ...startKey };
    let lastEvaluated: Record<string, unknown> | undefined;
    for (let i = 0; i < MAX_QUERIES_PER_STATUS && items.length <= need; i++) {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: BY_STATUS,
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { ...names, ...Object.fromEntries(SUMMARY_FIELDS.map((f) => [`#f_${f}`, f])) },
          ExpressionAttributeValues: values,
          ProjectionExpression: SUMMARY_FIELDS.map((f) => `#f_${f}`).join(', '),
          ...(filters.length && { FilterExpression: filters.join(' AND ') }),
          ScanIndexForward: false, // newest first
          ExclusiveStartKey: exclusiveStart,
          Limit: Math.max(need + 1, 25),
        }),
      );
      items.push(...((res.Items ?? []) as SyncSummary[]));
      lastEvaluated = res.LastEvaluatedKey;
      if (!lastEvaluated) break;
      exclusiveStart = lastEvaluated;
    }

    if (items.length > need) return { items: items.slice(0, need), exhausted: false };
    return {
      items,
      exhausted: !lastEvaluated,
      ...(lastEvaluated && { scanPosition: lastEvaluated as unknown as StatusKey }),
    };
  }

  private async conditionalPut(
    record: SyncRecord,
    condition: string,
    names?: Record<string, string>,
    values?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: condition,
          ...(names && { ExpressionAttributeNames: names }),
          ...(values && { ExpressionAttributeValues: values }),
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}

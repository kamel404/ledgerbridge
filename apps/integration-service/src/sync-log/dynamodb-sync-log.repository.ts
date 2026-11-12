import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SyncLogRepository, SyncRecord } from './sync-record.js';

/**
 * SyncLog table on DynamoDB (SPEC §8.5): pk = eventId, GSI byStatus
 * (pk = status, sk = updatedAt) for the dashboard, `ttl` for 90-day expiry.
 *
 * `create` is the ingest dedup (SPEC §8.1): a conditional put that only
 * succeeds if no item with this eventId exists. Two copies of the same webhook
 * racing each other: exactly one wins, the other gets `false`.
 */
export class DynamoDbSyncLogRepository implements SyncLogRepository {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tableName: string,
  ) {
    this.db = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
  }

  async create(record: SyncRecord): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: 'attribute_not_exists(eventId)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
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
}

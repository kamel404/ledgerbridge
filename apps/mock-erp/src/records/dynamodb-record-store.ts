import { TransactionCanceledException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { NetSuiteError } from '../common/netsuite-error.js';
import type { RecordStore, StoredRecord } from './record-store.js';
import type { RecordType } from './record-types.js';

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/**
 * DynamoDB version of the RecordStore (SPEC §7.5), one table, three kinds of item:
 *
 *   pk = <type>          sk = <internalId>   the record itself
 *   pk = <type>          sk = "#counter"     next internal ID for that type
 *   pk = <type>#eid      sk = <externalId>   external ID -> internal ID lookup
 *
 * Why a lookup item and not a GSI on externalId (what the spec suggests):
 * a GSI is updated a moment *after* the write and can't be read consistently,
 * so a retry right after a create could miss the record and make a duplicate.
 * The lookup item is read with ConsistentRead, and its conditional write
 * ("only if no other record owns this external ID") makes duplicates
 * impossible even with several Lambda copies running at once.
 *
 * Optimistic locking: each record carries a `version`. A save only succeeds if
 * the stored version is still the one that was read; otherwise it fails with
 * 409 RCRD_HAS_BEEN_CHANGED and the caller retries.
 */
export class DynamoDbRecordStore implements RecordStore {
  private readonly db: DynamoDBDocumentClient;

  constructor(
    client: DynamoDBClient,
    private readonly tableName: string,
  ) {
    this.db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async nextId(type: RecordType): Promise<string> {
    const res = await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: type, sk: COUNTER_SK },
        UpdateExpression: 'ADD #n :one',
        ExpressionAttributeNames: { '#n': 'next' },
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    return String(res.Attributes!.next);
  }

  async get(type: RecordType, id: string): Promise<StoredRecord | undefined> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: type, sk: id }, ConsistentRead: true }),
    );
    return res.Item ? fromItem(res.Item) : undefined;
  }

  async getByExternalId(type: RecordType, externalId: string): Promise<StoredRecord | undefined> {
    const res = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: eidPk(type), sk: externalId },
        ConsistentRead: true,
      }),
    );
    const id = res.Item?.id as string | undefined;
    return id === undefined ? undefined : this.get(type, id);
  }

  async list(type: RecordType): Promise<StoredRecord[]> {
    const records: StoredRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': type },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of res.Items ?? []) {
        if (!String(item.sk).startsWith('#')) records.push(fromItem(item));
      }
      start = res.LastEvaluatedKey;
    } while (start);
    return records.sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** All records and their lookup items in one transaction: all saved, or none. */
  async save(records: StoredRecord[]): Promise<void> {
    const items: TransactItem[] = [];
    for (const record of records) {
      const previous = record.version === undefined ? undefined : await this.get(record.type, record.id);
      items.push(this.putRecord(record));
      if (record.externalId && record.externalId !== previous?.externalId) {
        items.push(this.claimExternalId(record));
      }
      if (previous?.externalId && previous.externalId !== record.externalId) {
        items.push({ Delete: { TableName: this.tableName, Key: { pk: eidPk(record.type), sk: previous.externalId } } });
      }
    }
    await this.transact(items);
  }

  async delete(type: RecordType, id: string): Promise<boolean> {
    const record = await this.get(type, id);
    if (!record) return false;
    const items: TransactItem[] = [{ Delete: { TableName: this.tableName, Key: { pk: type, sk: id } } }];
    if (record.externalId) {
      items.push({ Delete: { TableName: this.tableName, Key: { pk: eidPk(type), sk: record.externalId } } });
    }
    await this.transact(items);
    return true;
  }

  // -------------------------------------------------------------------------

  private putRecord(record: StoredRecord): TransactItem {
    const isNew = record.version === undefined;
    const { version: _read, ...rest } = record;
    return {
      Put: {
        TableName: this.tableName,
        Item: { pk: record.type, sk: record.id, ...rest, version: (record.version ?? 0) + 1 },
        ConditionExpression: isNew ? 'attribute_not_exists(pk)' : 'version = :v',
        ...(!isNew && { ExpressionAttributeValues: { ':v': record.version } }),
      },
    };
  }

  /** Lookup item for the external ID. Fails if another record already owns it. */
  private claimExternalId(record: StoredRecord): TransactItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: { pk: eidPk(record.type), sk: record.externalId, id: record.id },
        ConditionExpression: 'attribute_not_exists(pk) OR id = :id',
        ExpressionAttributeValues: { ':id': record.id },
      },
    };
  }

  private async transact(items: TransactItem[]): Promise<void> {
    if (items.length === 0) return;
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      const lostRace =
        err instanceof TransactionCanceledException &&
        err.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed');
      if (lostRace) {
        throw new NetSuiteError(
          409,
          'RCRD_HAS_BEEN_CHANGED',
          'Record has been changed by another request at the same time. Retry the request.',
        );
      }
      throw err;
    }
  }
}

const COUNTER_SK = '#counter';

function eidPk(type: RecordType): string {
  return `${type}#eid`;
}

function fromItem(item: Record<string, unknown>): StoredRecord {
  return {
    type: item.type as RecordType,
    id: item.id as string,
    ...(typeof item.externalId === 'string' && { externalId: item.externalId }),
    fields: (item.fields ?? {}) as Record<string, unknown>,
    computed: (item.computed ?? {}) as Record<string, unknown>,
    createdDate: item.createdDate as string,
    lastModifiedDate: item.lastModifiedDate as string,
    version: item.version as number,
  };
}

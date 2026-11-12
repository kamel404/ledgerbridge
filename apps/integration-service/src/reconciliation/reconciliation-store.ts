import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ReconciliationReport } from './reconciliation-report.js';

/** Where reconciliation results are kept: the latest for the dashboard, plus a history. */
export interface ReconciliationStore {
  save(report: ReconciliationReport): Promise<void>;
  latest(): Promise<ReconciliationReport | undefined>;
}

export const RECONCILIATION_STORE = Symbol('RECONCILIATION_STORE');

const LATEST = 'latest';
const HISTORY_DAYS = 90;

/**
 * Reconciliation table on DynamoDB, key `runId`:
 *   "latest"          the most recent run (what the dashboard reads)
 *   "run#<runAt>"     every run, deleted by TTL after 90 days
 */
export class DynamoDbReconciliationStore implements ReconciliationStore {
  private readonly db: Pick<DynamoDBDocumentClient, 'send'>;

  /** `db` is for tests (a fake document client); normally it's built from `client`. */
  constructor(
    client: DynamoDBClient | undefined,
    private readonly tableName: string,
    db?: Pick<DynamoDBDocumentClient, 'send'>,
  ) {
    this.db = db ?? DynamoDBDocumentClient.from(client!, { marshallOptions: { removeUndefinedValues: true } });
  }

  async save(report: ReconciliationReport): Promise<void> {
    const ttl = Math.floor(Date.parse(report.runAt) / 1000) + HISTORY_DAYS * 24 * 3600;
    await this.db.send(new PutCommand({ TableName: this.tableName, Item: { runId: `run#${report.runAt}`, ttl, ...report } }));
    await this.db.send(new PutCommand({ TableName: this.tableName, Item: { runId: LATEST, ...report } }));
  }

  async latest(): Promise<ReconciliationReport | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.tableName, Key: { runId: LATEST } }));
    if (!res.Item) return undefined;
    const { runId: _runId, ttl: _ttl, ...report } = res.Item;
    return report as ReconciliationReport;
  }
}

/** Local and tests: lost on restart. */
export class InMemoryReconciliationStore implements ReconciliationStore {
  readonly runs: ReconciliationReport[] = [];

  async save(report: ReconciliationReport): Promise<void> {
    this.runs.push(structuredClone(report));
  }

  async latest(): Promise<ReconciliationReport | undefined> {
    const last = this.runs.at(-1);
    return last && structuredClone(last);
  }
}

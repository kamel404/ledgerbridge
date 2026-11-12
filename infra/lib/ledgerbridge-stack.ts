import cdk from 'aws-cdk-lib';
import apigw from 'aws-cdk-lib/aws-apigatewayv2';
import integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { NestFunction } from './shared.ts';

export interface LedgerBridgeStackProps extends cdk.StackProps {
  /** Secrets Manager secret {"billing": "...", "procurement": "..."}, created by `npm run aws:secrets`. */
  readonly webhookSecretName: string;
  /** Secrets Manager secret {"clientId": "...", "clientSecret": "..."} for the ERP, also from `npm run aws:secrets`. */
  readonly erpSecretName: string;
  /** Where the ERP lives: the mock ERP stack's URL, or a real NetSuite later. Not a secret. */
  readonly erpBaseUrl: string;
}

/** Worker Lambda timeout. The queue's visibility timeout is derived from it. */
export const WORKER_TIMEOUT = cdk.Duration.seconds(30);

/**
 * The product (SPEC §4, §8): webhook in -> sync log -> queue -> worker -> ERP.
 *
 *   API Gateway --> ingest Lambda --> SyncLog table (RECEIVED, dedup)
 *                                 \-> SQS SyncQueue --> worker Lambda --> ERP
 *                                       \-> after 4 failed receives: SyncDLQ
 */
export class LedgerBridgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LedgerBridgeStackProps) {
    super(scope, id, props);

    // ---- Queue + dead-letter queue -------------------------------------------
    // A message that fails 4 times moves to the DLQ, so it stops retrying but
    // isn't lost (SPEC §8.2). 14 days is the longest SQS keeps a message.
    const dlq = new sqs.Queue(this, 'SyncDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    // Visibility timeout = 6x the worker's timeout (AWS guidance), so a message
    // doesn't reappear while a worker is still processing it.
    const queue = new sqs.Queue(this, 'SyncQueue', {
      visibilityTimeout: cdk.Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 4 },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // ---- Sync log table (SPEC §8.5) ------------------------------------------
    const syncLog = new dynamodb.TableV2(this, 'SyncLog', {
      partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // DynamoDB deletes an item for free once the time in `ttl` has passed (90 days).
      timeToLiveAttribute: 'ttl',
      // "All FAILED records, newest first" for the dashboard (Phase 7).
      globalSecondaryIndexes: [
        {
          indexName: 'byStatus',
          partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
        },
      ],
      // Learning project: `cdk destroy` removes everything (SPEC §12). A real
      // system would RETAIN this table and turn on point-in-time recovery.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Both secrets are created outside CDK by `npm run aws:secrets`, so their
    // values never appear in a CloudFormation template. CDK only knows the names.
    const webhookSecret = secretsmanager.Secret.fromSecretNameV2(this, 'WebhookSecret', props.webhookSecretName);
    const erpSecret = secretsmanager.Secret.fromSecretNameV2(this, 'ErpSecret', props.erpSecretName);

    // ---- Ingest Lambda ---------------------------------------------------------
    const ingest = new NestFunction(this, 'Ingest', {
      app: 'integration-service',
      entry: 'http',
      description: 'LedgerBridge webhook ingest: verify, validate, dedup, enqueue',
      timeout: cdk.Duration.seconds(10),
      environment: {
        SYNC_LOG_TABLE: syncLog.tableName,
        SYNC_QUEUE_URL: queue.queueUrl,
        // The secret's *name*, not its value. The Lambda reads it at runtime.
        WEBHOOK_SECRET_NAME: props.webhookSecretName,
      },
    });
    // Exactly what ingest needs, nothing more. Anything else -> AccessDenied.
    syncLog.grantReadWriteData(ingest);
    queue.grantSendMessages(ingest);
    webhookSecret.grantRead(ingest);

    // ---- Worker Lambda (SPEC §8.2) ---------------------------------------------
    const worker = new NestFunction(this, 'Worker', {
      app: 'integration-service',
      entry: 'worker',
      description: 'LedgerBridge worker: queue -> flow handler -> ERP',
      timeout: WORKER_TIMEOUT,
      environment: {
        SYNC_LOG_TABLE: syncLog.tableName,
        ERP_BASE_URL: props.erpBaseUrl,
        ERP_SECRET_NAME: props.erpSecretName,
      },
    });
    // AWS polls the queue and calls the worker with up to 5 messages.
    // reportBatchItemFailures: only the messages the worker lists as failed
    // return to the queue, not the whole batch.
    // maxConcurrency: at most 5 worker copies at once, so a burst of events
    // can't flood the ERP (the mock allows 25 requests/s).
    worker.addEventSource(
      new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true, maxConcurrency: 5 }),
    );
    // The event source already lets the worker receive/delete/change visibility
    // on this queue. Plus: read and update sync records, read the ERP secret.
    syncLog.grantReadWriteData(worker);
    erpSecret.grantRead(worker);

    // ---- Public HTTP API -------------------------------------------------------
    const api = new apigw.HttpApi(this, 'HttpApi', {
      description: 'LedgerBridge webhooks',
      createDefaultStage: false,
    });
    const ingestIntegration = new integrations.HttpLambdaIntegration('IngestIntegration', ingest);
    api.addRoutes({ path: '/webhooks/{source}', methods: [apigw.HttpMethod.POST], integration: ingestIntegration });
    api.addRoutes({ path: '/health', methods: [apigw.HttpMethod.GET], integration: ingestIntegration });
    new apigw.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      // At most 20 requests/s (bursts of 40). Beyond that API Gateway answers
      // 429 itself, without running (or billing) the Lambda.
      throttle: { rateLimit: 20, burstLimit: 40 },
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint, description: 'Send webhooks to <ApiUrl>/webhooks/<source>' });
    new cdk.CfnOutput(this, 'SyncQueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'SyncDlqUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'SyncLogTableName', { value: syncLog.tableName });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: worker.functionName });
  }
}

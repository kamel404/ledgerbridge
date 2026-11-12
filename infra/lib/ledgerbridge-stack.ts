import cdk from 'aws-cdk-lib';
import apigw from 'aws-cdk-lib/aws-apigatewayv2';
import integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import dynamodb from 'aws-cdk-lib/aws-dynamodb';
import iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import s3 from 'aws-cdk-lib/aws-s3';
import s3n from 'aws-cdk-lib/aws-s3-notifications';
import secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { Monitoring } from './monitoring.ts';
import { NestFunction } from './shared.ts';

export interface LedgerBridgeStackProps extends cdk.StackProps {
  /** Secrets Manager secret {"billing": "...", "procurement": "..."}, created by `npm run aws:secrets`. */
  readonly webhookSecretName: string;
  /** Secrets Manager secret {"clientId": "...", "clientSecret": "..."} for the ERP, also from `npm run aws:secrets`. */
  readonly erpSecretName: string;
  /** Where the ERP lives: the mock ERP stack's URL, or a real NetSuite later. Not a secret. */
  readonly erpBaseUrl: string;
  /** Alarm emails go here (ALARM_EMAIL in .env.aws). Optional: without it nobody is notified. */
  readonly alarmEmail?: string;
  /** Secrets Manager secret {"apiKey": "..."} for the admin API, from `npm run aws:secrets`. */
  readonly adminSecretName: string;
}

/** Worker Lambda timeout. The queue's visibility timeout is derived from it. */
export const WORKER_TIMEOUT = cdk.Duration.seconds(30);

/**
 * The product (SPEC §4, §8): webhook in -> sync log -> queue -> worker -> ERP.
 *
 *   API Gateway --> ingest Lambda --\
 *   S3 incoming/*.csv --> CSV Lambda --> SyncLog table (RECEIVED, dedup)
 *                                    \-> SQS SyncQueue --> worker Lambda --> ERP
 *                                          \-> after 4 failed receives: SyncDLQ --> DLQ Lambda (DEAD)
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
    const adminSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AdminSecret', props.adminSecretName);

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

    // ---- Dead-letter handler (SPEC §8.2) -----------------------------------------
    // Marks each event that lands in the DLQ as DEAD. The trigger removes the
    // message from the DLQ afterwards; the sync record keeps the event for replay.
    const dlqHandler = new NestFunction(this, 'DlqHandler', {
      app: 'integration-service',
      entry: 'dlq',
      description: 'LedgerBridge: marks events in the dead-letter queue DEAD',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { SYNC_LOG_TABLE: syncLog.tableName },
    });
    dlqHandler.addEventSource(new SqsEventSource(dlq, { batchSize: 10, reportBatchItemFailures: true }));
    syncLog.grantReadWriteData(dlqHandler);

    // ---- CSV import (SPEC §6.2) --------------------------------------------------
    //   incoming/  finance uploads here (the only place uploads are allowed)
    //   processed/ the CSV Lambda moves each file here when it's done
    //   rejected/  <file>.errors.csv with the bad rows, and files refused as a whole
    const csvBucket = new s3.Bucket(this, 'CsvImports', {
      // Nothing in this bucket can ever be made public.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // Files are encrypted on disk with keys S3 manages (free).
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Refuse plain-HTTP requests.
      enforceSSL: true,
      // Only IAM decides access; ACLs (an old per-object permission system) are off.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Old files cost storage forever otherwise.
      lifecycleRules: [
        { prefix: 'processed/', expiration: cdk.Duration.days(90) },
        { prefix: 'rejected/', expiration: cdk.Duration.days(90) },
        // A file nobody processed (e.g. not .csv) shouldn't linger either.
        { prefix: 'incoming/', expiration: cdk.Duration.days(30) },
      ],
      // Learning project: `cdk destroy` empties and deletes the bucket.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const csvImport = new NestFunction(this, 'CsvImport', {
      app: 'integration-service',
      entry: 'csv',
      description: 'LedgerBridge CSV import: incoming/*.csv -> bill events on the queue',
      timeout: cdk.Duration.seconds(60),
      environment: {
        SYNC_LOG_TABLE: syncLog.tableName,
        SYNC_QUEUE_URL: queue.queueUrl,
      },
    });
    // Read and delete only in incoming/, write only to processed/ and rejected/.
    csvBucket.grantRead(csvImport, 'incoming/*');
    csvBucket.grantDelete(csvImport, 'incoming/*');
    csvBucket.grantPut(csvImport, 'processed/*');
    csvBucket.grantPut(csvImport, 'rejected/*');
    // Same intake as webhooks: dedup + RECEIVED in the sync log, then the queue.
    syncLog.grantReadWriteData(csvImport);
    queue.grantSendMessages(csvImport);

    // "When a .csv file is created under incoming/, call the CSV Lambda."
    // The Lambda writes to other prefixes, so it never triggers itself.
    csvBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(csvImport), {
      prefix: 'incoming/',
      suffix: '.csv',
    });

    // Uploads only under incoming/ (SPEC §10). The bucket policy refuses a
    // PutObject anywhere else from anyone except the CSV Lambda, even from an
    // admin whose own IAM permissions would allow it.
    csvBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'UploadsOnlyToIncoming',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        notResources: [csvBucket.arnForObjects('incoming/*')],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': csvImport.role!.roleArn } },
      }),
    );

    // ---- Admin API Lambda (SPEC §8.6) --------------------------------------------
    // Same code bundle as ingest, but its own function and role: only /admin/*
    // reaches it, and only it may read the admin key, replay events (send to
    // the queue) and read queue depths. The webhook Lambda gets none of that.
    const admin = new NestFunction(this, 'Admin', {
      app: 'integration-service',
      entry: 'http',
      description: 'LedgerBridge admin API for the dashboard: list, detail, replay, stats',
      timeout: cdk.Duration.seconds(15),
      environment: {
        SYNC_LOG_TABLE: syncLog.tableName,
        SYNC_QUEUE_URL: queue.queueUrl,
        SYNC_DLQ_URL: dlq.queueUrl,
        ADMIN_SECRET_NAME: props.adminSecretName,
      },
    });
    syncLog.grantReadWriteData(admin); // includes Query on the byStatus index
    queue.grantSendMessages(admin); // replay
    queue.grant(admin, 'sqs:GetQueueAttributes');
    dlq.grant(admin, 'sqs:GetQueueAttributes');
    adminSecret.grantRead(admin);

    // ---- Public HTTP API -------------------------------------------------------
    const api = new apigw.HttpApi(this, 'HttpApi', {
      description: 'LedgerBridge webhooks',
      createDefaultStage: false,
    });
    const ingestIntegration = new integrations.HttpLambdaIntegration('IngestIntegration', ingest);
    api.addRoutes({ path: '/webhooks/{source}', methods: [apigw.HttpMethod.POST], integration: ingestIntegration });
    api.addRoutes({ path: '/health', methods: [apigw.HttpMethod.GET], integration: ingestIntegration });
    // Protected by the X-Api-Key check inside the app (ApiKeyGuard).
    const adminIntegration = new integrations.HttpLambdaIntegration('AdminIntegration', admin);
    api.addRoutes({
      path: '/admin/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: adminIntegration,
    });
    new apigw.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      // At most 20 requests/s (bursts of 40). Beyond that API Gateway answers
      // 429 itself, without running (or billing) the Lambda.
      throttle: { rateLimit: 20, burstLimit: 40 },
    });

    // ---- Alarms, dashboard, saved log query (SPEC §11) ------------------------------
    new Monitoring(this, 'Monitoring', {
      queue,
      dlq,
      worker,
      csvImport,
      functions: { ingest, worker, csvImport, dlqHandler, admin },
      alarmEmail: props.alarmEmail,
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint, description: 'Send webhooks to <ApiUrl>/webhooks/<source>' });
    new cdk.CfnOutput(this, 'SyncQueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'SyncDlqUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'SyncLogTableName', { value: syncLog.tableName });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: worker.functionName });
    new cdk.CfnOutput(this, 'CsvBucketName', {
      value: csvBucket.bucketName,
      description: 'Upload vendor-bill CSVs to s3://<CsvBucketName>/incoming/',
    });
  }
}

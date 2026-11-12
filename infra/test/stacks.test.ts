import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LedgerBridgeStack } from '../lib/ledgerbridge-stack.ts';
import { MockErpStack } from '../lib/mock-erp-stack.ts';
import { REPO_ROOT } from '../lib/shared.ts';

// Synth needs the Lambda bundle folders to exist; an empty placeholder is enough
// when they haven't been built (the content isn't inspected here).
for (const app of ['mock-erp', 'integration-service']) {
  const dir = path.join(REPO_ROOT, 'apps', app, 'dist-lambda');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.keep'), '');
}

const env = { account: '123456789012', region: 'eu-north-1' };

describe('LedgerBridgeStack', () => {
  const template = Template.fromStack(
    new LedgerBridgeStack(new cdk.App(), 'LB', {
      env,
      webhookSecretName: 'ledgerbridge/webhooks',
      erpSecretName: 'ledgerbridge/erp',
      erpBaseUrl: 'https://erp.example',
      alarmEmail: 'ops@example.com',
      adminSecretName: 'ledgerbridge/admin',
    }),
  );

  it('moves a message to the DLQ after 4 failed receives', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: { maxReceiveCount: 4, deadLetterTargetArn: Match.anyValue() },
      VisibilityTimeout: 180, // 6 x the 30 s worker timeout
    });
  });

  it('has the SyncLog table with the byStatus index and TTL', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [{ AttributeName: 'eventId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'byStatus',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'updatedAt', KeyType: 'RANGE' },
          ],
        }),
      ],
    });
  });

  it('gives the ingest Lambda the secret name, never a secret value', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'http.handler',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({ WEBHOOK_SECRET_NAME: 'ledgerbridge/webhooks' }),
      },
    });
    const fns = template.findResources('AWS::Lambda::Function');
    for (const fn of Object.values(fns)) {
      const vars = Object.keys(fn.Properties.Environment?.Variables ?? {});
      expect(vars.filter((v) => /SECRET(?!_NAME)/.test(v))).toEqual([]);
    }
  });

  /** The IAM policy statements attached to one Lambda's role, as JSON text. */
  function policyOf(fnLogicalIdPrefix: string): string {
    const fns = template.findResources('AWS::Lambda::Function');
    const fnId = Object.keys(fns).find((id) => id.startsWith(fnLogicalIdPrefix))!;
    const roleId = fns[fnId]!.Properties.Role['Fn::GetAtt'][0] as string;
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.Roles).includes(roleId),
    );
    return JSON.stringify(policies.map((p) => p.Properties.PolicyDocument));
  }

  it('lets ingest send to the queue but not receive or delete', () => {
    const policy = policyOf('Ingest');
    expect(policy).toContain('sqs:SendMessage');
    expect(policy).not.toContain('sqs:ReceiveMessage');
    expect(policy).not.toContain('sqs:DeleteMessage');
    expect(policy).not.toContain('ErpSecret'); // ingest never talks to the ERP
    expect(policy).not.toContain('secret:ledgerbridge/admin'); // nor serves the admin API
  });

  it('lets the worker consume the queue and read the ERP secret, but not send or read webhook secrets', () => {
    const policy = policyOf('Worker');
    expect(policy).toContain('sqs:ReceiveMessage');
    expect(policy).toContain('sqs:ChangeMessageVisibility');
    expect(policy).not.toContain('sqs:SendMessage');
    expect(policy).toContain('secret:ledgerbridge/erp');
    expect(policy).not.toContain('secret:ledgerbridge/webhooks');
  });

  it('triggers the worker from the queue: batches of 5, partial failures, at most 5 at once', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 5,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'worker.handler',
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({ ERP_BASE_URL: 'https://erp.example', ERP_SECRET_NAME: 'ledgerbridge/erp' }),
      },
    });
  });

  it('the admin Lambda reads the admin key and sync log, can replay and read queue depths, nothing else', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'http.handler',
      Environment: { Variables: Match.objectLike({ ADMIN_SECRET_NAME: 'ledgerbridge/admin', SYNC_DLQ_URL: Match.anyValue() }) },
    });
    const policy = policyOf('Admin');
    expect(policy).toContain('secret:ledgerbridge/admin');
    expect(policy).not.toContain('secret:ledgerbridge/webhooks');
    expect(policy).not.toContain('secret:ledgerbridge/erp');
    expect(policy).toContain('dynamodb:Query');
    expect(policy).toContain('sqs:SendMessage');
    expect(policy).toContain('sqs:GetQueueAttributes');
    expect(policy).not.toContain('sqs:ReceiveMessage');
    expect(policy).not.toContain('s3:');
  });

  it('the DLQ handler is triggered by the DLQ and can only touch the sync log', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'dlq.handler' });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^SyncDLQ'), 'Arn'] },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    const policy = policyOf('DlqHandler');
    expect(policy).toContain('dynamodb:UpdateItem');
    expect(policy).not.toContain('secretsmanager');
    expect(policy).not.toContain('sqs:SendMessage');
  });

  it('keeps the CSV bucket private, encrypted and HTTPS-only', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    });
    const bucketPolicy = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
    expect(bucketPolicy).toContain('aws:SecureTransport');
  });

  it('refuses uploads outside incoming/ for everyone but the CSV Lambda', () => {
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'));
    const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>);
    const deny = statements.find((s) => s.Sid === 'UploadsOnlyToIncoming')!;
    expect(deny).toMatchObject({ Effect: 'Deny', Action: 's3:PutObject', Principal: { AWS: '*' } });
    expect(JSON.stringify(deny.NotResource)).toContain('/incoming/*');
    expect(JSON.stringify(deny.Condition)).toContain('CsvImport');
  });

  it('calls the CSV Lambda for .csv files under incoming/ only', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: [
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                // arrayWith is order-sensitive; CDK writes the suffix rule first.
                FilterRules: Match.arrayWith([
                  { Name: 'suffix', Value: '.csv' },
                  { Name: 'prefix', Value: 'incoming/' },
                ]),
              },
            },
          }),
        ],
      },
    });
  });

  it('lets the CSV Lambda read incoming/, write processed/ and rejected/, and send to the queue', () => {
    const policy = policyOf('CsvImport');
    expect(policy).toContain('/incoming/*');
    expect(policy).toContain('/processed/*');
    expect(policy).toContain('/rejected/*');
    expect(policy).toContain('sqs:SendMessage');
    expect(policy).not.toContain('sqs:ReceiveMessage');
    expect(policy).not.toContain('secretsmanager');
  });

  describe('reconciliation', () => {
    it('runs the reconcile Lambda at 02:00 UTC every day, retrying a failed call twice', () => {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(0 2 * * ? *)',
        ScheduleExpressionTimezone: 'Etc/UTC',
        State: 'ENABLED',
        Target: Match.objectLike({
          Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Reconcile'), 'Arn'] },
          RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 2 }),
        }),
      });
    });

    it('stores results in their own table with a TTL', () => {
      template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        KeySchema: [{ AttributeName: 'runId', KeyType: 'HASH' }],
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      });
    });

    it('reads the sync log and the ERP secret, writes results, and cannot change sync records or queues', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'reconcile.handler',
        Timeout: 300,
        Environment: {
          Variables: Match.objectLike({
            ERP_SECRET_NAME: 'ledgerbridge/erp',
            SYNC_LOG_TABLE: Match.anyValue(),
            RECONCILIATION_TABLE: Match.anyValue(),
          }),
        },
      });
      const policy = JSON.parse(policyOf('Reconcile')) as Array<{ Statement: Array<{ Action: string | string[]; Resource: unknown }> }>;
      const statements = policy.flatMap((p) => p.Statement);
      const actionsOn = (table: string) =>
        statements.filter((s) => JSON.stringify(s.Resource).includes(table)).flatMap((s) => [s.Action].flat());
      expect(actionsOn('SyncLog')).toContain('dynamodb:Query');
      expect(actionsOn('SyncLog').filter((a) => /Put|Update|Delete|Write/.test(a))).toEqual([]);
      expect(actionsOn('Reconciliation')).toContain('dynamodb:PutItem');
      const text = JSON.stringify(policy);
      expect(text).toContain('secret:ledgerbridge/erp');
      expect(text).not.toContain('secret:ledgerbridge/webhooks');
      expect(text).not.toContain('sqs:');
    });

    it('lets the admin API read the latest result', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'http.handler',
        Environment: { Variables: Match.objectLike({ ADMIN_SECRET_NAME: 'ledgerbridge/admin', RECONCILIATION_TABLE: Match.anyValue() }) },
      });
    });
  });

  describe('monitoring', () => {
    const alarms = () => Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties);
    const alarm = (name: string) => alarms().find((a) => a.AlarmName === `LedgerBridge-${name}`)!;

    it('has the seven alarms, each emailing on ALARM and on OK', () => {
      expect(alarms().map((a) => a.AlarmName).sort()).toEqual([
        'LedgerBridge-CsvImportErrors',
        'LedgerBridge-DeadLetters',
        'LedgerBridge-QueueBacklog',
        'LedgerBridge-ReconcileErrors',
        'LedgerBridge-ReconciliationMismatches',
        'LedgerBridge-SyncFailures',
        'LedgerBridge-WorkerErrors',
      ]);
      for (const a of alarms()) {
        expect(a.AlarmActions).toHaveLength(1);
        expect(a.OKActions).toHaveLength(1);
        // Reconciliation reports once a day: between runs the alarm keeps its state.
        expect(a.TreatMissingData).toBe(a.AlarmName === 'LedgerBridge-ReconciliationMismatches' ? 'ignore' : 'notBreaching');
      }
    });

    it('alarms when a reconciliation run reports any mismatch', () => {
      expect(alarm('ReconciliationMismatches')).toMatchObject({
        Namespace: 'LedgerBridge',
        MetricName: 'ReconciliationMismatches',
        Dimensions: [{ Name: 'service', Value: 'ledgerbridge' }],
        Statistic: 'Maximum',
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });

    it('alarms on messages arriving in the DLQ (it empties itself)', () => {
      expect(alarm('DeadLetters')).toMatchObject({
        MetricName: 'NumberOfMessagesReceived',
        Statistic: 'Sum',
        Period: 60,
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });

    it('alarms on 5+ failed events in 5 minutes, both flows added up', () => {
      const a = alarm('SyncFailures');
      expect(a).toMatchObject({ Threshold: 5, EvaluationPeriods: 1 });
      const metrics = a.Metrics as Array<{ Expression?: string; MetricStat?: { Metric: { MetricName: string; Namespace: string; Dimensions: unknown[] }; Period: number } }>;
      expect(metrics.find((m) => m.Expression)!.Expression).toBe('FILL(syncfailed_o2c, 0) + FILL(syncfailed_p2p, 0)');
      const stats = metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat!);
      expect(stats).toHaveLength(2);
      for (const st of stats) {
        expect(st).toMatchObject({ Period: 300, Metric: { MetricName: 'SyncFailed', Namespace: 'LedgerBridge' } });
        // Exactly the dimensions the app writes (see observability.spec.ts in integration-service).
        expect(st.Metric.Dimensions).toEqual(expect.arrayContaining([{ Name: 'service', Value: 'ledgerbridge' }]));
      }
    });

    it('alarms on worker errors 2 minutes in a row and on a 10-minute backlog', () => {
      expect(alarm('WorkerErrors')).toMatchObject({ MetricName: 'Errors', EvaluationPeriods: 2, DatapointsToAlarm: 2, Threshold: 0 });
      expect(alarm('QueueBacklog')).toMatchObject({ MetricName: 'ApproximateAgeOfOldestMessage', Statistic: 'Maximum', Threshold: 600 });
    });

    it('subscribes the alarm email to an HTTPS-only topic', () => {
      template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
      expect(JSON.stringify(template.findResources('AWS::SNS::TopicPolicy'))).toContain('aws:SecureTransport');
    });

    it('lets CloudWatch alarms publish to the topic, only for LedgerBridge alarms of this account', () => {
      // Without this the topic policy only denies, and alarms fail with "not authorized to perform SNS:Publish".
      const statements = Object.values(template.findResources('AWS::SNS::TopicPolicy')).flatMap(
        (p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
      );
      const allow = statements.find((s) => s.Sid === 'AllowLedgerBridgeAlarms')!;
      expect(allow).toMatchObject({
        Effect: 'Allow',
        Action: 'sns:Publish',
        Principal: { Service: 'cloudwatch.amazonaws.com' },
        Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
      });
      expect(JSON.stringify(allow.Condition)).toContain(':alarm:LedgerBridge-*');
    });

    it('has a dashboard and a saved "trace one event" query over all six log groups', () => {
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
      template.hasResourceProperties('AWS::Logs::QueryDefinition', { Name: 'LedgerBridge/Trace one event' });
      const q = Object.values(template.findResources('AWS::Logs::QueryDefinition'))[0]!.Properties;
      expect(q.LogGroupNames).toHaveLength(6);
      expect(q.QueryString).toContain('filter eventId =');
    });

    it('gives the LedgerBridge Lambdas the Powertools settings', () => {
      const fns = Object.values(template.findResources('AWS::Lambda::Function')).filter((f) =>
        /^(http|worker|csv|dlq|reconcile).handler$/.test(f.Properties.Handler),
      );
      expect(fns).toHaveLength(6); // ingest, worker, csv, dlq, admin, reconcile
      for (const f of fns) {
        expect(f.Properties.Environment.Variables).toMatchObject({
          POWERTOOLS_SERVICE_NAME: 'ledgerbridge',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        });
      }
    });
  });

  it('keeps logs for 7 days', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  it('throttles the API', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it('routes only the webhook, health and admin paths', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 4);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /admin/{proxy+}' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /admin/{proxy+}' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /webhooks/{source}' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /health' });
  });
});

describe('MockErpStack', () => {
  const template = Template.fromStack(
    new MockErpStack(new cdk.App(), 'Mock', { env, clientId: 'c', clientSecret: 's', jwtSecret: 'j' }),
  );

  it('has one records table keyed by pk/sk, billed per request', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('has chaos off unless asked for', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ CHAOS_ERROR_RATE: '0' }) },
    });
    const chaotic = Template.fromStack(
      new MockErpStack(new cdk.App(), 'Chaos', { env, clientId: 'c', clientSecret: 's', jwtSecret: 'j', chaosErrorRate: 1 }),
    );
    chaotic.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ CHAOS_ERROR_RATE: '1' }) },
    });
  });

  it('points the Lambda at the table', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ MOCK_ERP_TABLE_NAME: Match.anyValue() }) },
    });
  });
});

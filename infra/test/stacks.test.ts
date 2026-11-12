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

  it('keeps logs for 7 days', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  it('throttles the API', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it('routes only the webhook and health paths', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 2);
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

  it('points the Lambda at the table', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ MOCK_ERP_TABLE_NAME: Match.anyValue() }) },
    });
  });
});

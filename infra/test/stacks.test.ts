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
    new LedgerBridgeStack(new cdk.App(), 'LB', { env, webhookSecretName: 'ledgerbridge/webhooks' }),
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

  it('lets ingest send to the queue but not receive or delete', () => {
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('sqs:SendMessage');
    expect(policies).not.toContain('sqs:ReceiveMessage');
    expect(policies).not.toContain('sqs:DeleteMessage');
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

import cdk from 'aws-cdk-lib';
import apigw from 'aws-cdk-lib/aws-apigatewayv2';
import integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import { NestFunction } from './shared.ts';

export interface MockErpStackProps extends cdk.StackProps {
  /** OAuth client the integration logs in with. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** Key the mock signs its JWT access tokens with. */
  readonly jwtSecret: string;
  /**
   * Share of ERP requests answered with 503 (0 to 1), for testing alarms.
   * Set per deploy with `npm run chaos -- <rate>`; a normal deploy resets it to 0.
   */
  readonly chaosErrorRate?: number;
}

/**
 * The fake NetSuite (SPEC §7) on AWS: one DynamoDB table, one Lambda running
 * the whole Nest app, and a public HTTPS URL from API Gateway.
 *
 * Kept in its own stack so LedgerBridge could point at a real NetSuite later
 * and this stack would simply not be deployed.
 */
export class MockErpStack extends cdk.Stack {
  /** e.g. https://abc123.execute-api.eu-north-1.amazonaws.com */
  readonly url: string;

  constructor(scope: Construct, id: string, props: MockErpStackProps) {
    super(scope, id, props);

    // Records, external-ID lookups and ID counters, all in one table (see DynamoDbRecordStore).
    // On-demand billing: pay per request, nothing when idle.
    // DESTROY: `cdk destroy` deletes the data too. Fine for a mock; never do this for real data.
    const table = new dynamodb.TableV2(this, 'Records', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new NestFunction(this, 'Api', {
      app: 'mock-erp',
      entry: 'http',
      description: 'Mock ERP (fake NetSuite): OAuth, record API, SuiteQL',
      environment: {
        MOCK_ERP_TABLE_NAME: table.tableName,
        MOCK_ERP_CLIENT_ID: props.clientId,
        // Acceptable here only because this is the *fake* ERP (PLAN Phase 3).
        // LedgerBridge's own secrets live in Secrets Manager.
        MOCK_ERP_CLIENT_SECRET: props.clientSecret,
        MOCK_ERP_JWT_SECRET: props.jwtSecret,
        // An env var, not PUT /mock/chaos: that only changes the one Lambda
        // container that happens to answer, so other copies keep working.
        CHAOS_ERROR_RATE: String(props.chaosErrorRate ?? 0),
      },
    });
    table.grantReadWriteData(fn);

    // HTTP API: a public URL that forwards every request to the Lambda.
    // Throttling caps requests per second so a flood can't run up the bill.
    const api = new apigw.HttpApi(this, 'HttpApi', {
      description: 'Mock ERP',
      defaultIntegration: new integrations.HttpLambdaIntegration('MockErpIntegration', fn),
      createDefaultStage: false,
    });
    new apigw.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });

    this.url = api.apiEndpoint;
    new cdk.CfnOutput(this, 'MockErpUrl', { value: api.apiEndpoint, description: 'Base URL of the mock ERP' });
    new cdk.CfnOutput(this, 'RecordsTableName', { value: table.tableName });
  }
}

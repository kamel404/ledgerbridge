import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdk from 'aws-cdk-lib';
import lambda from 'aws-cdk-lib/aws-lambda';
import logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The rspack Lambda bundle of an app (`npm run build:lambda` creates it). */
export function lambdaBundle(app: 'mock-erp' | 'integration-service'): lambda.Code {
  return lambda.Code.fromAsset(path.join(REPO_ROOT, 'apps', app, 'dist-lambda'));
}

export interface NestFunctionProps {
  readonly app: 'mock-erp' | 'integration-service';
  /** Entry file in dist-lambda, e.g. "http" -> handler "http.handler". */
  readonly entry: string;
  readonly description: string;
  readonly environment?: Record<string, string>;
  readonly timeout?: cdk.Duration;
  readonly memorySize?: number;
}

/**
 * A Lambda running one of our Nest bundles.
 *
 * - `lambda.Function` + `Code.fromAsset`, not `NodejsFunction`: NodejsFunction
 *   re-bundles with esbuild, which drops the decorator metadata Nest needs
 *   (SPEC §5 gotcha). We upload the rspack bundle as it is.
 * - arm64 (Graviton): about 20% cheaper than x86 for the same work; our
 *   bundle is plain JavaScript, so the CPU type doesn't matter.
 * - Its own log group with 7-day retention. By default Lambda logs are kept
 *   forever and billed per GB stored.
 * - integration-service Lambdas get the Powertools settings: JSON logs with
 *   service "ledgerbridge" at INFO level, metrics in namespace LedgerBridge.
 * - CDK gives every Function its own IAM role. Stacks then add only the
 *   permissions it needs with grant*() calls.
 */
export class NestFunction extends lambda.Function {
  constructor(scope: Construct, id: string, props: NestFunctionProps) {
    const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    super(scope, id, {
      description: props.description,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: `${props.entry}.handler`,
      code: lambdaBundle(props.app),
      memorySize: props.memorySize ?? 512,
      timeout: props.timeout ?? cdk.Duration.seconds(15),
      environment: {
        NODE_ENV: 'production',
        ...(props.app === 'integration-service' && {
          POWERTOOLS_SERVICE_NAME: 'ledgerbridge',
          POWERTOOLS_METRICS_NAMESPACE: 'LedgerBridge',
          POWERTOOLS_LOG_LEVEL: 'INFO',
        }),
        ...props.environment,
      },
      logGroup,
    });
  }
}

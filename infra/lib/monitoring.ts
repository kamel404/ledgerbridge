import cdk from 'aws-cdk-lib';
import cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import iam from 'aws-cdk-lib/aws-iam';
import type lambda from 'aws-cdk-lib/aws-lambda';
import logs from 'aws-cdk-lib/aws-logs';
import sns from 'aws-cdk-lib/aws-sns';
import subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** Must match the app: namespace, service name (POWERTOOLS_SERVICE_NAME) and metric names. */
export const METRICS_NAMESPACE = 'LedgerBridge';
export const SERVICE_NAME = 'ledgerbridge';
const FLOWS = ['O2C', 'P2P'] as const;

export interface MonitoringProps {
  readonly queue: sqs.IQueue;
  readonly dlq: sqs.IQueue;
  readonly worker: lambda.IFunction;
  readonly csvImport: lambda.IFunction;
  /** Every LedgerBridge Lambda, for the error graph and the log queries. */
  readonly functions: Record<string, lambda.Function>;
  /** Where alarm emails go. Without it the topic exists but nobody is subscribed. */
  readonly alarmEmail?: string;
}

/**
 * Alarms, the email topic, the CloudWatch dashboard and a saved log query
 * (SPEC §11).
 *
 *   alarm -> SNS topic "LedgerBridgeAlarms" -> email (after you confirm the subscription)
 *
 * Every alarm also emails when it goes back to OK, so you know it's over.
 */
export class Monitoring extends Construct {
  readonly topic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    // Not KMS-encrypted on purpose: CloudWatch alarms can't publish to a topic
    // encrypted with the AWS-managed SNS key. Alarm emails hold no secrets.
    this.topic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'LedgerBridge alarms',
      enforceSSL: true,
    });
    // enforceSSL gives the topic its own policy, which replaces SNS's default
    // one, so nothing may publish unless allowed here. Found on the first
    // real alarm: "CloudWatch Alarms is not authorized to perform: SNS:Publish".
    // Only CloudWatch, only for this account's LedgerBridge-* alarms.
    const stack = cdk.Stack.of(this);
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLedgerBridgeAlarms',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:LedgerBridge-*` },
        },
      }),
    );
    if (props.alarmEmail) {
      // AWS emails a confirmation link first. Nothing arrives until it's clicked.
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    const syncMetric = (name: string, flow: string, statistic: string, period = cdk.Duration.minutes(5)) =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: name,
        dimensionsMap: { service: SERVICE_NAME, flow },
        statistic,
        period,
      });
    /** Sum of a count metric over both flows; a missing data point counts as 0. */
    const allFlows = (name: string, label: string, period = cdk.Duration.minutes(5)) => {
      // IDs must be unique within one graph, e.g. syncfailed_o2c.
      const id = (flow: string) => `${name}_${flow}`.toLowerCase();
      return new cloudwatch.MathExpression({
        expression: FLOWS.map((f) => `FILL(${id(f)}, 0)`).join(' + '),
        usingMetrics: Object.fromEntries(FLOWS.map((f) => [id(f), syncMetric(name, f, 'Sum', period)])),
        label,
        period,
      });
    };

    // ---- Alarms ----------------------------------------------------------------
    // "Received" rather than "visible": the DLQ handler empties the DLQ within
    // seconds (Phase 5), so messages never sit there. Every dead message is
    // received exactly once by that handler, which this counts.
    this.alarm('DeadLetters', {
      alarmDescription: 'An event failed 4 times and landed in the dead-letter queue. It is now DEAD in the sync log.',
      metric: props.dlq.metricNumberOfMessagesReceived({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
    });
    this.alarm('SyncFailures', {
      alarmDescription: '5 or more events failed permanently in 5 minutes (bad data or missing mappings).',
      metric: allFlows('SyncFailed', 'Failed events'),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
    });
    this.alarm('WorkerErrors', {
      alarmDescription: 'The worker Lambda itself failed (crash, timeout) 2 minutes in a row.',
      metric: props.worker.metricErrors({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
    });
    this.alarm('QueueBacklog', {
      alarmDescription: 'A message has been waiting in the sync queue for more than 10 minutes.',
      metric: props.queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 600,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });
    // Not in the spec: a crashed import is otherwise silent (the file just stays in incoming/).
    this.alarm('CsvImportErrors', {
      alarmDescription: 'The CSV import Lambda failed. The uploaded file is probably still in incoming/.',
      metric: props.csvImport.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });

    // ---- Saved Logs Insights query -----------------------------------------------
    const logGroups = Object.values(props.functions).map((fn) => fn.logGroup);
    new logs.QueryDefinition(this, 'TraceOneEvent', {
      queryDefinitionName: 'LedgerBridge/Trace one event',
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@log', 'level', 'context', 'message', 'attempt', 'receiveCount', 'error.message'],
        filterStatements: ['eventId = "PASTE-EVENT-ID-HERE"'],
        sort: '@timestamp asc',
      }),
      logGroups,
    });

    // ---- Dashboard -----------------------------------------------------------------
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'LedgerBridge',
      defaultInterval: cdk.Duration.hours(3),
    });
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms: this.alarms, width: 24, height: 3 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Events by outcome (per 5 min)',
        width: 12,
        stacked: true,
        left: [
          allFlows('SyncSucceeded', 'Succeeded'),
          allFlows('SyncRetried', 'Retried'),
          allFlows('SyncFailed', 'Failed'),
          allFlows('SyncDead', 'Dead'),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Time in the ERP per event (ms)',
        width: 12,
        left: FLOWS.flatMap((f) => [
          syncMetric('SyncDurationMs', f, 'p50').with({ label: `${f} p50` }),
          syncMetric('SyncDurationMs', f, 'p95').with({ label: `${f} p95` }),
        ]),
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Sync queue',
        width: 12,
        left: [
          props.queue.metricApproximateNumberOfMessagesVisible({ label: 'Waiting', statistic: 'Maximum' }),
          props.queue.metricApproximateNumberOfMessagesNotVisible({ label: 'Being processed / waiting to retry', statistic: 'Maximum' }),
        ],
        right: [props.queue.metricApproximateAgeOfOldestMessage({ label: 'Oldest message (s)', statistic: 'Maximum' })],
      }),
      new cloudwatch.GraphWidget({
        title: 'Dead events',
        width: 12,
        left: [
          props.dlq.metricNumberOfMessagesReceived({ label: 'Arrived in the DLQ', statistic: 'Sum' }),
          allFlows('SyncDead', 'Marked DEAD'),
        ],
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda errors',
        width: 12,
        left: Object.entries(props.functions).map(([name, fn]) => fn.metricErrors({ label: name, statistic: 'Sum' })),
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda duration p95 (ms)',
        width: 12,
        left: Object.entries(props.functions).map(([name, fn]) => fn.metricDuration({ label: name, statistic: 'p95' })),
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Latest warnings and errors',
        width: 24,
        height: 8,
        logGroupNames: logGroups.map((g) => g.logGroupName),
        queryLines: [
          'fields @timestamp, level, context, eventId, message',
          'filter level = "WARN" or level = "ERROR"',
          'sort @timestamp desc',
          'limit 50',
        ],
      }),
    );

    new cdk.CfnOutput(cdk.Stack.of(this), 'DashboardUrl', {
      value: `https://${cdk.Stack.of(this).region}.console.aws.amazon.com/cloudwatch/home?region=${cdk.Stack.of(this).region}#dashboards/dashboard/LedgerBridge`,
    });
    new cdk.CfnOutput(cdk.Stack.of(this), 'AlarmTopicArn', { value: this.topic.topicArn });
  }

  private alarm(id: string, props: cloudwatch.AlarmProps) {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: `LedgerBridge-${id}`,
      // No data (e.g. nothing happening at night) is good news, not an alarm.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      ...props,
    });
    alarm.addAlarmAction(new actions.SnsAction(this.topic));
    alarm.addOkAction(new actions.SnsAction(this.topic));
    this.alarms.push(alarm);
  }
}

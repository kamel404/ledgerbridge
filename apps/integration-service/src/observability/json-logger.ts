import { Logger as PowertoolsLogger } from '@aws-lambda-powertools/logger';
import type { LoggerService } from '@nestjs/common';
import type { Context } from 'aws-lambda';
import { currentLogContext } from './log-context.js';
import { redact } from './redact.js';

/** True when running inside AWS Lambda. */
export function isLambda(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * One Powertools logger per Lambda container. It writes one JSON object per
 * line with level, timestamp, service, cold_start and the Lambda request ID
 * (after addContext). Service name and level come from POWERTOOLS_* env vars
 * set by CDK.
 */
export const powertoolsLogger = new PowertoolsLogger({ serviceName: process.env.POWERTOOLS_SERVICE_NAME ?? 'ledgerbridge' });

/** Nest options: JSON logs on Lambda, Nest's readable console logger locally. */
export function nestLoggerOptions(): { logger?: LoggerService } {
  return isLambda() ? { logger: new JsonLogger() } : {};
}

/** Call at the start of each invocation: adds the request ID and cold-start flag to every line. */
export function addLambdaContext(context: Context | undefined): void {
  if (context?.awsRequestId) powertoolsLogger.addContext(context);
}

/** Nest's start-up chatter ("dependencies initialized", "Mapped {/health, GET}") goes to debug. */
const NOISY_CONTEXTS = new Set(['NestFactory', 'InstanceLoader', 'RoutesResolver', 'RouterExplorer', 'NestApplication']);

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Nest LoggerService that writes through Powertools. Every existing
 * `new Logger(SomeClass.name).log(...)` call becomes a JSON line with:
 *   message  redacted (emails masked, tokens removed)
 *   context  the class name
 *   eventId, flow, eventType, attempt  from withLogContext()
 *   error    name/message/stack when an Error was passed
 *
 * Used on Lambda only; locally Nest's readable console logger stays.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly pt: PowertoolsLogger = powertoolsLogger) {}

  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]) {
    // Nest appends the logger's context (class name) as the last string parameter.
    const context = typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    const error = params.find((p): p is Error => p instanceof Error);
    // Nest passes a stack string as the 2nd parameter of error() in some paths.
    const stack = params.find((p): p is string => typeof p === 'string' && p.includes('\n    at '));

    const extra: Record<string, unknown> = { ...currentLogContext() };
    if (context) extra.context = context;
    if (error) extra.error = { name: error.name, message: redact(error.message), stack: error.stack && redact(error.stack) };
    else if (stack) extra.stack = redact(stack);

    const text = redact(typeof message === 'string' ? message : JSON.stringify(message));
    this.pt[context && NOISY_CONTEXTS.has(context) ? 'debug' : level](text, extra);
  }
}

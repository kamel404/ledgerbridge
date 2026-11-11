import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { NetSuiteError, buildErrorBody, type NetSuiteErrorCode } from './netsuite-error.js';
import { OAuthError } from './oauth-error.js';

const CODE_BY_STATUS: Record<number, NetSuiteErrorCode> = {
  400: 'INVALID_CONTENT',
  401: 'INVALID_LOGIN',
  404: 'NOT_FOUND',
  429: 'REQUEST_LIMIT_EXCEEDED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Turns every error into the response format a NetSuite client expects:
 * - OAuthError (token endpoint) -> OAuth 2.0 body { error, error_description }
 * - NetSuiteError               -> NetSuite body with o:errorDetails
 * - Nest HttpException          -> NetSuite body (e.g. unknown route, bad JSON)
 * - anything else               -> 500 UNEXPECTED_ERROR, logged
 */
@Catch()
export class NetSuiteErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(NetSuiteErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof OAuthError) {
      res.status(exception.status).json(exception.toBody());
      return;
    }

    if (exception instanceof NetSuiteError) {
      res.set(exception.headers).status(exception.status).json(exception.toBody());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'object' && response !== null && 'message' in response
          ? String((response as { message: unknown }).message)
          : exception.message;
      res.status(status).json(buildErrorBody(status, CODE_BY_STATUS[status] ?? 'UNEXPECTED_ERROR', message));
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(500).json(buildErrorBody(500, 'UNEXPECTED_ERROR', 'An unexpected error occurred'));
  }
}

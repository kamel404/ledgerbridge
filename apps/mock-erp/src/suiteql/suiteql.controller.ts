import { Body, Controller, Headers, HttpCode, Post, Query } from '@nestjs/common';
import { NetSuiteError } from '../common/netsuite-error.js';
import { MAX_LIMIT, SuiteQlService, type SuiteQlResult } from './suiteql.service.js';

/**
 * POST /services/rest/query/v1/suiteql?limit=&offset=
 * Header: Prefer: transient (required by NetSuite)
 * Body:   { "q": "SELECT ..." }
 */
@Controller('services/rest/query/v1')
export class SuiteQlController {
  constructor(private readonly suiteql: SuiteQlService) {}

  @Post('suiteql')
  @HttpCode(200)
  query(
    @Body() body: { q?: unknown } | undefined,
    @Headers('prefer') prefer?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<SuiteQlResult> {
    if (!prefer?.toLowerCase().split(',').map((s) => s.trim()).includes('transient')) {
      throw NetSuiteError.badRequest('INVALID_CONTENT', 'SuiteQL requests need the header "Prefer: transient"');
    }
    if (typeof body?.q !== 'string' || !body.q.trim()) {
      throw NetSuiteError.badRequest('INVALID_CONTENT', 'Body must be { "q": "SELECT ..." }');
    }
    return this.suiteql.run(body.q, parseIntParam('limit', limit, MAX_LIMIT, 1, MAX_LIMIT), parseIntParam('offset', offset, 0, 0));
  }
}

function parseIntParam(name: string, raw: string | undefined, fallback: number, min: number, max = Infinity): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
    throw NetSuiteError.badRequest('INVALID_CONTENT', `Query parameter ${name} must be an integer ${range}`);
  }
  return value;
}

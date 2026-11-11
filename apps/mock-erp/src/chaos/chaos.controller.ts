import { Body, Controller, Get, Put } from '@nestjs/common';
import { z } from 'zod';
import type { ChaosSettings } from '../config/mock-erp.config.js';
import { NetSuiteError } from '../common/netsuite-error.js';
import { ChaosService } from './chaos.service.js';

const ChaosUpdate = z.strictObject({
  errorRate: z.number().min(0).max(1).optional(),
  latencyMs: z.number().int().min(0).max(30_000).optional(),
  rateLimitPerSecond: z.number().int().min(0).optional(),
});

/**
 * Mock-only admin routes (not part of NetSuite). Need a Bearer token, but are
 * not subject to chaos themselves, so you can always turn chaos off.
 *
 *   GET /mock/chaos                      current settings
 *   PUT /mock/chaos  { "errorRate": 1 }  change some settings
 */
@Controller('mock/chaos')
export class ChaosController {
  constructor(private readonly chaos: ChaosService) {}

  @Get()
  get(): ChaosSettings {
    return this.chaos.get();
  }

  @Put()
  update(@Body() body: unknown): ChaosSettings {
    const parsed = ChaosUpdate.safeParse(body);
    if (!parsed.success) {
      throw NetSuiteError.badRequest('INVALID_CONTENT', z.prettifyError(parsed.error));
    }
    return this.chaos.update(parsed.data);
  }
}

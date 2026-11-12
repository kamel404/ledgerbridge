import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Flow, SyncStatus } from '@ledgerbridge/shared';
import { z } from 'zod';
import { InvalidCursorError, type ListPage } from '../sync-log/sync-list.js';
import type { SyncRecord } from '../sync-log/sync-record.js';
import { AdminService, type Stats } from './admin.service.js';
import { ApiKeyGuard } from './api-key.guard.js';

const ListParams = z.strictObject({
  status: SyncStatus.optional(),
  flow: Flow.optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Admin API (SPEC §8.6), for the dashboard. Every route needs X-Api-Key.
 *
 *   GET  /admin/stats                        counts per status/flow (24 h), queue depths
 *   GET  /admin/syncs?status&flow&q&cursor    newest first, 25 per page
 *   GET  /admin/syncs/:eventId               full record: payload, error, history
 *   POST /admin/syncs/:eventId/replay        FAILED or DEAD only
 */
@Controller('admin')
@UseGuards(ApiKeyGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('stats')
  stats(): Promise<Stats> {
    return this.admin.stats();
  }

  @Get('syncs')
  async list(@Query() query: Record<string, unknown>): Promise<ListPage> {
    // Empty form fields arrive as "": treat them as not set.
    const cleaned = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
    const parsed = ListParams.safeParse(cleaned);
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    try {
      return await this.admin.list(parsed.data);
    } catch (err) {
      if (err instanceof InvalidCursorError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Get('syncs/:eventId')
  async get(@Param('eventId') eventId: string): Promise<SyncRecord> {
    const record = await this.admin.get(eventId);
    if (!record) throw new NotFoundException(`No sync record ${eventId}`);
    return record;
  }

  @Post('syncs/:eventId/replay')
  @HttpCode(202)
  async replay(@Param('eventId') eventId: string): Promise<{ syncId: string; status: SyncStatus }> {
    const result = await this.admin.replay(eventId);
    if (result.outcome === 'not-found') throw new NotFoundException(`No sync record ${eventId}`);
    if (result.outcome === 'not-replayable') {
      throw new ConflictException(
        `Only FAILED or DEAD events can be replayed; this one is ${result.status ?? 'unknown'}`,
      );
    }
    return { syncId: eventId, status: result.record.status };
  }
}
